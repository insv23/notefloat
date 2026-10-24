package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"log"

	"github.com/egoist/mygo"
)

// toggleShortcut summons and dismisses the panel from any app.
const toggleShortcut = "Alt+V"

// PanelShown tells the page the panel just appeared, so that it can put the
// caret back in the block the user was editing: the panel takes the keyboard
// without activating the app, and the page's own focus does not survive being
// hidden.
var PanelShown = mygo.NewEvent[bool]("panelShown")

func main() {
	mygo.App.SetName("Notefloat")
	// An accessory app has no Dock icon and no app switcher entry: the panel
	// and the menu bar icon are the way in, and showing the panel must not
	// bring the app to the front over the app the user is in.
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	mygo.App.OnWindowAllClosed(func() {})

	// The notes and the pictures, and the scheme the page loads them with.
	// Schemes are registered per window, so this comes before the panel.
	mygo.Bind(&Notes{})
	mygo.Bind(&Images{})
	serveImages()

	mygo.App.WhenReady(func() {
		panel := newPanel()
		startImageSweep()
		toggle := toggler(panel)
		if err := mygo.GlobalShortcut.Register(toggleShortcut, toggle); err != nil {
			log.Printf("registering %s: %v", toggleShortcut, err)
		}
		addTray(toggle)
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

// newPanel creates the notes window hidden: it is created once and hidden
// rather than closed, so that showing it again keeps the page and its state.
func newPanel() *mygo.Window {
	panel := mygo.NewWindow(mygo.WindowOptions{
		Title:       "Notefloat",
		Panel:       true, // never activates the app, floats over every Space
		Frameless:   true,
		Hidden:      true,
		Transparent: true,
		Vibrancy:    mygo.VibrancyHUD,
		Width:       900,
		Height:      620,
		MinWidth:    520,
		MinHeight:   320,
		// The page's --bg in src/style.css, shown until it paints.
		BackgroundColor: "light-dark(#f8f8fa, #17191f)",
		// Saves the size the user resized the panel to; the position is set
		// on show instead, see toggler.
		StateKey: "notefloat",
		URL:      "/",
	})
	// Escape, Cmd-W and the close button hide the panel.
	panel.OnClose(func(e *mygo.CloseEvent) {
		e.PreventDefault()
		panel.Hide()
	})
	return panel
}

// toggler returns the shortcut's action: hide the panel if it shows, and
// otherwise show it, on the display with the pointer the first time it
// appears in this run, as Spotlight does. The panel never activates the app,
// so hiding it from another app leaves that app with the keyboard.
func toggler(panel *mygo.Window) func() {
	placed := false
	return func() {
		if panel.IsVisible() {
			panel.Hide()
			// Hiding the panel alone leaves an active app with no windows,
			// which swallows what the user types next; hiding the app hands
			// the keyboard back to the app they came from.
			mygo.App.Hide()
			return
		}
		if !placed {
			d := mygo.Screen.DisplayNearestPoint(mygo.Screen.CursorScreenPoint())
			width, height := panel.Size()
			panel.SetPosition(
				d.WorkArea.X+(d.WorkArea.Width-width)/2,
				d.WorkArea.Y+(d.WorkArea.Height-height)/3,
			)
			placed = true
		}
		mygo.App.Show()
		panel.Show()
		// Activating the app is what makes the system come back to it when a
		// floating window of another app, a clipboard manager's for instance,
		// closes: a panel that never activates its app hands the keyboard back
		// to the app that was active all along.
		mygo.App.Focus()
		if err := PanelShown.Emit(panel, true); err != nil {
			log.Print(err)
		}
	}
}

// addTray puts the app in the menu bar: with no Dock icon, the tray menu is
// how the user summons the panel and quits the app.
func addTray(toggle func()) {
	menu := mygo.NewMenu([]*mygo.MenuItem{
		{
			Label:       "显示 Notefloat",
			Accelerator: toggleShortcut,
			Click:       func(*mygo.MenuItem, *mygo.Window) { toggle() },
		},
		mygo.Separator(),
		{Label: "退出 Notefloat", Role: mygo.RoleQuit},
	})
	tray, err := mygo.NewTray(mygo.TrayOptions{
		ID:             "notefloat",
		Icon:           trayIcon(),
		IconIsTemplate: true,
		ToolTip:        "Notefloat — " + toggleShortcut,
		Menu:           menu,
	})
	if err != nil {
		log.Printf("adding the tray icon: %v", err)
		return
	}
	_ = tray
}

// trayIcon draws the menu bar icon, three bars of a note, as a template
// image: macOS tints it for light and dark menu bars.
func trayIcon() []byte {
	const size = 32
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	ink := color.RGBA{A: 0xff}
	for i, top := range []int{7, 14, 21} {
		width := size - 10
		if i == 2 {
			width -= 8
		}
		for y := top; y < top+3; y++ {
			for x := 5; x < 5+width; x++ {
				img.Set(x, y, ink)
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		log.Printf("encoding the tray icon: %v", err)
		return nil
	}
	return buf.Bytes()
}
