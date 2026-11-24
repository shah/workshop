"""Short-lived SSH key enrollment for the local Workshop account."""

import argparse
import base64
import binascii
import fcntl
from contextlib import contextmanager
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import select
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time

MARKER = b"snshah-enrolled:"
DURATION = 300
LABEL = re.compile(rb"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,39}")


def fingerprint(blob):
    digest = base64.b64encode(hashlib.sha256(blob).digest()).rstrip(b"=")
    return "SHA256:" + digest.decode("ascii")


def public_key(line):
    fields = line.split(None, 2)
    if len(fields) < 2 or fields[0] != b"ssh-ed25519":
        raise ValueError("Expected one ssh-ed25519 public key.")
    try:
        blob = base64.b64decode(fields[1], validate=True)
    except binascii.Error as error:
        raise ValueError("Invalid public key encoding.") from error
    if len(blob) != 51 or not blob.startswith(b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20"):
        raise ValueError("Invalid Ed25519 public key.")
    return base64.b64encode(blob), fingerprint(blob)


def managed_device(line):
    fields = line.split()
    if len(fields) != 3 or not fields[2].startswith(MARKER):
        return None
    label = fields[2][len(MARKER):]
    if not LABEL.fullmatch(label):
        return None
    try:
        key, digest = public_key(line)
    except ValueError:
        return None
    return label.decode("ascii"), key, digest


def with_authorized_keys(edit=None):
    directory = Path.home() / ".ssh"
    path = directory / "authorized_keys"
    if edit is None and not os.path.lexists(path):
        return []
    directory.mkdir(mode=0o700, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError("Expected a user-owned ~/.ssh directory without group or other write access.")
    flags = os.O_NOFOLLOW | os.O_NONBLOCK
    lock = os.open(directory / ".snshah-enrollment.lock", os.O_CREAT | os.O_RDWR | flags, 0o600)
    with os.fdopen(lock, "rb") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            file = os.open(path, os.O_RDONLY | flags)
        except FileNotFoundError:
            original = b""
        else:
            with os.fdopen(file, "rb") as keys:
                info = os.fstat(keys.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                    raise ValueError("Expected a user-owned regular authorized_keys file.")
                original = keys.read()
        lines = original.splitlines(keepends=True)
        if edit is None:
            return [device for line in lines if (device := managed_device(line))]
        updated = edit(original, lines)
        draft = None
        try:
            with tempfile.NamedTemporaryFile(dir=directory, delete=False) as file:
                draft = file.name
                file.write(updated)
                file.flush()
                os.fsync(file.fileno())
            if path.is_symlink() or (path.read_bytes() if path.exists() else b"") != original:
                raise ValueError("authorized_keys changed during enrollment. Try again.")
            os.replace(draft, path)
        finally:
            if draft is not None:
                Path(draft).unlink(missing_ok=True)


def authorize(label, key):
    def add(original, lines):
        for line in lines:
            if line.lstrip().startswith(b"#"):
                continue
            if key in line.split():
                raise ValueError("This key is already in authorized_keys.")
            device = managed_device(line)
            if device and device[0] == label:
                raise ValueError("This device name is already enrolled.")
        separator = b"\n" if original and not original.endswith(b"\n") else b""
        return original + separator + b"ssh-ed25519 " + key + b" " + MARKER + label.encode() + b"\n"

    with_authorized_keys(add)


def revoke(label):
    def remove(_original, lines):
        remaining = [line for line in lines if not ((device := managed_device(line)) and device[0] == label)]
        if len(remaining) == len(lines):
            raise ValueError("No enrolled device has that name.")
        return b"".join(remaining)

    with_authorized_keys(remove)


def choose_interface():
    interfaces = json.loads(subprocess.check_output(["ip", "-j", "-4", "address", "show", "scope", "global"]))
    choices = []
    for interface in interfaces:
        for address in interface.get("addr_info", []):
            network = ipaddress.IPv4Interface(f"{address['local']}/{address['prefixlen']}")
            choices.append((interface["ifname"], network))
    if not choices:
        raise ValueError("No LAN IPv4 address found.")
    for index, (name, network) in enumerate(choices, 1):
        print(f"{index}. {name}  {network}")
    choice = input("Select the LAN address [number, or Enter to cancel]: ").strip()
    if not choice:
        return None
    if not choice.isascii() or not choice.isdigit() or not 1 <= int(choice) <= len(choices):
        raise ValueError("Invalid LAN address selection.")
    return choices[int(choice) - 1][1]


def time_left(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Enrollment expired.")
    return remaining


def receive_line(channel, deadline, limit):
    line = bytearray()
    while len(line) <= limit:
        channel.settimeout(min(time_left(deadline), 5))
        if not channel.recv_ready() and not channel.active:
            raise EOFError()
        try:
            char = channel.recv(1)
        except socket.timeout:
            continue
        if char == b"" or char in (b"\x03", b"\x04"):
            raise EOFError()
        if char in (b"\r", b"\n"):
            return bytes(line)
        if char in (b"\x7f", b"\x08"):
            del line[-1:]
        else:
            line.extend(char)
    raise ValueError("Input too long.")


def tell(channel, message):
    channel.settimeout(3)
    channel.sendall(message.encode("ascii"))


def collect_key(channel, deadline):
    tell(channel, "\r\nSSH key enrollment\r\n1. Windows PowerShell\r\n2. macOS\r\n3. Linux / WSL\r\nChoose 1, 2, or 3: ")
    os_choice = receive_line(channel, deadline, 3)
    if os_choice not in (b"1", b"2", b"3"):
        raise ValueError("Choose Windows, macOS, or Linux / WSL.")
    key_path = '$HOME/.ssh/id_ed25519_workshop'
    clipboard = {
        b"1": f'Get-Content "{key_path}.pub" | Set-Clipboard',
        b"2": f'pbcopy < "{key_path}.pub"',
        b"3": f'cat "{key_path}.pub"',
    }[os_choice]
    tell(channel, f'\r\nIn another local terminal, reuse an existing Ed25519 key or create one:\r\n'
         f'  ssh-keygen -t ed25519 -f "{key_path}"\r\n'
         f'Keep the private key on this PC. To copy or display the public key:\r\n'
         f'  {clipboard}\r\n'
         'Paste the single ssh-ed25519 line here and press Enter:\r\n')
    line = receive_line(channel, deadline, 2048)
    while not line:
        line = receive_line(channel, deadline, 2048)
    return public_key(line)


@contextmanager
def enrollment_firewall(interface, port):
    ufw = shutil.which("ufw")
    if not ufw:
        yield
        return
    command = ["sudo", "env", "LC_ALL=C", ufw]
    status = subprocess.check_output([*command, "status"], text=True)
    if not status.startswith("Status: active"):
        yield
        return
    rule = ["allow", "proto", "tcp", "from", str(interface.network),
            "to", str(interface.ip), "port", str(port)]
    try:
        subprocess.run([*command, *rule, "comment", "snshah enrollment"], check=True)
        yield
    finally:
        try:
            subprocess.run([*command, "--force", "delete", *rule], check=True)
        except subprocess.CalledProcessError:
            print(f"Remove the temporary firewall rule: sudo ufw delete {' '.join(rule)}", file=sys.stderr)
            raise


def approve_key(channel, transport, deadline, account, address, peer):
    key, digest = collect_key(channel, deadline)
    print(f"Request from {peer} for {account}. Public key: {digest}")
    print("Enter a device name to approve, or press Enter to deny: ", end="", flush=True)
    if not select.select([sys.stdin], [], [], time_left(deadline))[0]:
        raise TimeoutError("Enrollment expired before approval.")
    label = sys.stdin.readline().strip()
    time_left(deadline)
    if not label:
        tell(channel, "\r\nEnrollment denied.\r\n")
        channel.send_exit_status(1)
        return
    if not LABEL.fullmatch(label.encode()):
        raise ValueError("Use 1–40 letters, digits, underscores, dots, or hyphens.")
    if channel.closed or channel.eof_received or not transport.is_active():
        raise ValueError("Client disconnected before approval. Restart enrollment.")
    authorize(label, key)
    print(f"Enrolled {label}. Normal SSH account: {account}@{address}")
    try:
        tell(channel, f'\r\nApproved. Verify the normal SSH host fingerprint on first connection.\r\n'
             f'  ssh -i "$HOME/.ssh/id_ed25519_workshop" {account}@{address}\r\n'
             'If you reused a key, substitute its private key path.\r\n')
        channel.send_exit_status(0)
    except OSError:
        pass


def enroll():
    if os.getuid() == 0 or not sys.stdin.isatty() or not sys.stdout.isatty():
        raise ValueError("Open enrollment from a regular user's local terminal.")
    try:
        import paramiko
    except ImportError as error:
        raise ValueError("Install the enrollment dependency with omarchy pkg add python-paramiko.") from error

    interface = choose_interface()
    if interface is None:
        return
    account = pwd.getpwuid(os.getuid()).pw_name
    address = str(interface.ip)
    host_key = paramiko.RSAKey.generate(3072)
    code = secrets.token_urlsafe(12)
    used_code = False
    failures = 0

    class EnrollmentSession(paramiko.ServerInterface):
        def __init__(self):
            self.ready = threading.Event()
            self.channel_id = None

        def get_allowed_auths(self, username):
            return "password"

        def check_auth_password(self, username, password):
            nonlocal used_code, failures
            if time.monotonic() < deadline and not used_code and failures < 5 and username == "enroll" and hmac.compare_digest(password.encode(), code.encode()):
                used_code = True
                return paramiko.AUTH_SUCCESSFUL
            failures += 1
            return paramiko.AUTH_FAILED

        def check_channel_request(self, kind, chanid):
            if kind != "session" or self.channel_id is not None:
                return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
            self.channel_id = chanid
            return paramiko.OPEN_SUCCEEDED

        def check_channel_pty_request(self, channel, *args):
            return True

        def check_channel_shell_request(self, channel):
            self.ready.set()
            return True

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind((address, 0))
        listener.listen(4)
        port = listener.getsockname()[1]
        with enrollment_firewall(interface, port):
            deadline = time.monotonic() + DURATION
            print(f"On the new PC, run: ssh -p {port} enroll@{address}")
            print(f"Verify this enrollment host fingerprint: {fingerprint(host_key.asbytes())}")
            print(f"One-time password: {code}")
            print("Waiting up to five minutes. Press Ctrl+C to cancel.", flush=True)
            for _ in range(12):
                listener.settimeout(time_left(deadline))
                try:
                    connection, (peer, _) = listener.accept()
                except socket.timeout:
                    raise TimeoutError("Enrollment expired.") from None
                with connection:
                    if ipaddress.IPv4Address(peer) not in interface.network:
                        continue
                    session = EnrollmentSession()
                    with paramiko.Transport(connection, default_window_size=32768) as transport:
                        transport.add_server_key(host_key)
                        transport.banner_timeout = 5
                        transport.handshake_timeout = 5
                        transport.auth_timeout = 10
                        try:
                            transport.start_server(server=session)
                            channel = transport.accept(min(time_left(deadline), 15))
                            if channel is not None and session.ready.wait(min(time_left(deadline), 5)):
                                approve_key(channel, transport, deadline, account, address, peer)
                                return
                            if used_code:
                                raise ValueError("Client disconnected before submitting a key. Restart enrollment.")
                        except (paramiko.SSHException, EOFError):
                            if used_code:
                                raise ValueError("Enrollment connection ended. Restart enrollment.") from None
                    if failures >= 5:
                        break
            raise ValueError("Enrollment stopped after too many connection or authentication attempts.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("enroll", "devices", "revoke", "enable"))
    parser.add_argument("device", nargs="?")
    args = parser.parse_args()
    if args.action == "enroll":
        enroll()
    elif args.action == "enable":
        device = next((item for item in with_authorized_keys() if item[0] == args.device), None)
        if device is None:
            raise ValueError("Enroll a device first, then run snshah ssh enable DEVICE.")
        label, key, _ = device
        line = b"ssh-ed25519 " + key + b" " + MARKER + label.encode()
        subprocess.run(["omarchy", "setup", "security", "sshd", "--key=" + line.decode("ascii")], check=True)
        for host_key in sorted(Path("/etc/ssh").glob("ssh_host_*_key.pub")):
            subprocess.run(["ssh-keygen", "-lf", str(host_key)], check=True)
    elif args.action == "devices":
        devices = with_authorized_keys()
        for label, _, digest in devices:
            print(f"{label}  {digest}")
        if not devices:
            print("No devices enrolled through Workshop.")
    else:
        label = args.device or input("Device name to revoke: ").strip()
        revoke(label)
        print(f"Revoked {label}. Existing SSH sessions remain open.")


def terminate(_signal, _frame):
    raise KeyboardInterrupt


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, terminate)
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("Enrollment canceled.")
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
