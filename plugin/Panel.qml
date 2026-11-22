pragma ComponentBehavior: Bound
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui as Ui

Ui.Panel {
  id: root
  moduleName: "shah.ergonex"
  ipcTarget: root.moduleName
  readonly property string cli: Quickshell.env("HOME") + "/.local/bin/snshah"
  property string statusText: "Checking Ollama…"
  property int selected: 0
  readonly property var actions: [
    { label: "Open Herdr", args: ["open", "herdr"] },
    { label: "Open Work 1", args: ["open", "work1", "browser"] },
    { label: "Open Work 2", args: ["open", "work2", "browser"] },
    { label: "Open Work 3", args: ["open", "work3", "browser"] }
  ]

  function activate(index) {
    const action = root.actions[index]
    if (action) {
      Quickshell.execDetached([root.cli].concat(action.args))
      root.close()
    }
  }

  onOpenedChanged: {
    if (root.opened) {
      selected = 0
      statusText = "Checking Ollama…"
      status.running = true
    }
  }

  Process {
    id: status
    command: [root.cli, "doctor", "--json"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.statusText = JSON.parse(text).ollama === true ? "Ollama online" : "Ollama offline"
        } catch (error) {
          root.statusText = "Ollama status unavailable"
        }
      }
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.statusText = "Ollama status unavailable"
    }
  }

  Ui.BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰆍"
    onPressed: root.toggle()
  }

  Ui.KeyboardPanel {
    id: popup
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: popup.loadedContent
    contentWidth: popup.fittedContentWidth(Style.space(280))
    contentHeight: popup.fittedContentHeight(popup.loadedContentHeight, Style.space(360))
    content: Ui.PanelKeyCatcher {
      implicitHeight: rows.implicitHeight
      onMoveRequested: function(dx, dy) {
        if (dy !== 0)
          root.selected = (root.selected + dy + root.actions.length) % root.actions.length
      }
      onActivateRequested: root.activate(root.selected)
      onCloseRequested: root.close()
      Column {
        id: rows
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(6)
        Text {
          text: root.statusText
          textFormat: Text.PlainText
          color: Commons.Color.foreground
        }
        Repeater {
          model: root.actions
          delegate: Ui.Button {
            required property int index
            required property var modelData
            width: rows.width
            text: modelData.label
            selected: index === root.selected
            onClicked: root.activate(index)
          }
        }
      }
    }
  }
}
