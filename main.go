package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"

	"notefloat/internal/pictures"
	"notefloat/internal/prefs"
	"notefloat/internal/store"
)

// PanelShown tells the page the panel just appeared, so that it can put the
// caret back in the block the user was editing: the panel takes the keyboard
// without activating the app, and the page's own focus does not survive being
// hidden.
var PanelShown = mygo.NewEvent[bool]("panelShown")

// PanelHidden tells the page the panel just went away, so that it writes the
// note before the user can quit: the page saves a keystroke 400ms after the
// last one, and an app that quits within that window would lose them.
var PanelHidden = mygo.NewEvent[bool]("panelHidden")

// OpenSettings tells the page to show its settings, after the tray's Settings
// item showed the panel.
var OpenSettings = mygo.NewEvent[bool]("openSettings")

// quitting is set once the page has written the note it holds: the second pass
// of the quit sequence closes the panel instead of hiding it.
var quitting atomic.Bool

func main() {
	mygo.App.SetName("Notefloat")
	// An accessory app has no Dock icon and no app switcher entry: the panel
	// and the menu bar icon are the way in, and showing the panel must not
	// bring the app to the front over the app the user is in.
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	mygo.App.OnWindowAllClosed(func() {})

	// The notes and the pictures, and the scheme the page loads them with.
	// Schemes are registered per window, so this comes before the panel.
	notes := &store.Notes{}
	preferences := prefs.New(notes)
	if err := prefs.Startup(preferences); err != nil {
		log.Printf("reading the settings: %v", err)
	}
	// The notes live where the user put them, which is known before the first
	// note is read.
	mygo.App.SetPath(mygo.PathUserData, prefs.NotesDir(preferences))
	mygo.Bind(notes)
	mygo.Bind(preferences)
	mygo.Bind(&pictures.Images{})
	pictures.Serve()

	mygo.App.WhenReady(func() {
		panel := newPanel()
		prefs.UseWindow(preferences, panel)
		prefs.Apply(preferences)
		pictures.StartSweep()
		toggle := toggler(panel)

		// A quit from the tray menu arrives as Cmd-Q does, and the panel's close
		// handler cancels it: a window that hides itself has not closed, so the
		// quit never runs and the app is left with no way to stop it. The quit
		// is let through in two passes instead, the first one saving.
		mygo.App.OnBeforeQuit(func(e *mygo.QuitEvent) {
			if quitting.Load() {
				return
			}
			e.PreventDefault()
			go quitWithSave(panel)
		})

		shortcut := &globalShortcut{toggle: toggle}
		if err := shortcut.set(prefs.Accel(preferences, prefs.ActionTogglePanel)); err != nil {
			log.Printf("registering the panel shortcut: %v", err)
		}
		shortcut.tray = addTray(panel, shortcut)
		prefs.UseGlobal(preferences, shortcut.set)
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

// newPanel creates the notes window hidden: it is created once and hidden
// rather than closed, so that showing it again keeps the page and its state.
func newPanel() *mygo.Window {
	panel := mygo.NewWindow(mygo.WindowOptions{
		Title: "Notefloat",
		Panel: true, // never activates the app, floats over every Space
		// Floating from the start: the panel never activates the app, so a
		// window at the normal level would sit behind the windows of the app
		// the user is in, and Show would look like nothing happened.
		AlwaysOnTop: true,
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
	// Escape, Cmd-W and the close button hide the panel. A quit is the one time
	// the window closes for real: hiding it leaves the quit sequence cancelled
	// and the app running on with nothing to summon it from.
	panel.OnClose(func(e *mygo.CloseEvent) {
		if quitting.Load() {
			return
		}
		e.PreventDefault()
		hide(panel)
	})
	return panel
}

// quitWithSave hides the panel, waits for the page to write the note it holds,
// and quits for real. The page writes when it hears the panel went away, and a
// quit that closed the window before that write landed would lose the last
// keystrokes: the page saves them a moment after they are typed.
func quitWithSave(panel *mygo.Window) {
	written := make(chan struct{}, 1)
	store.OnSave(func() {
		select {
		case written <- struct{}{}:
		default:
		}
	})
	hide(panel)
	select {
	case <-written:
	case <-time.After(time.Second):
	}
	store.OnSave(nil)
	quitting.Store(true)
	mygo.App.Quit()
}

// hide hides the panel, after telling the page: the page writes the note it
// holds while it can still hear from the app.
func hide(panel *mygo.Window) {
	if err := PanelHidden.Emit(panel, true); err != nil {
		log.Print(err)
	}
	panel.Hide()
	// Hiding the panel alone leaves an active app with no windows, which
	// swallows what the user types next.
	mygo.App.Hide()
}

// show reveals the panel over the app the user is in, and puts it near the
// pointer the first time it appears in this run, as Spotlight does.
var placement struct {
	sync.Mutex
	placed bool
}

func show(panel *mygo.Window) {
	placement.Lock()
	first := !placement.placed
	placement.placed = true
	placement.Unlock()
	if first {
		d := mygo.Screen.DisplayNearestPoint(mygo.Screen.CursorScreenPoint())
		width, height := panel.Size()
		panel.SetPosition(
			d.WorkArea.X+(d.WorkArea.Width-width)/2,
			d.WorkArea.Y+(d.WorkArea.Height-height)/3,
		)
	}
	// The app is shown and focused around the panel. WebKit draws the insertion
	// point of a field only while the application counts as active, and a panel
	// that takes the keyboard without activating its app loses the caret of
	// every field that would have to be painted on its own: an empty line has
	// no text to repaint, so its caret never reaches the screen.
	mygo.App.Show()
	panel.Show()
	mygo.App.Focus()
	if err := PanelShown.Emit(panel, true); err != nil {
		log.Print(err)
	}
}

// toggler returns the shortcut's action: hide the panel if it shows, and
// otherwise show it. The panel never activates the app, so hiding it from
// another app leaves that app with the keyboard.
func toggler(panel *mygo.Window) func() {
	return func() {
		if panel.IsVisible() {
			hide(panel)
			return
		}
		show(panel)
	}
}

// globalShortcut keeps the one shortcut the system registers, so that changing
// it in the settings leaves the app with a working shortcut or with the one it
// had.
type globalShortcut struct {
	mu      sync.Mutex
	current string
	toggle  func()
	panel   *mygo.Window
	tray    *mygo.Tray
}

// set registers accel in place of the shortcut registered now. An empty accel
// leaves the system holding nothing, which is how the settings wait for the key
// that is to become the shortcut: the system takes the key it holds before the
// page sees it.
func (g *globalShortcut) set(accel string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.current == accel {
		return nil
	}
	mygo.GlobalShortcut.Unregister(g.current)
	if accel == "" {
		g.current = ""
		return nil
	}
	if err := mygo.GlobalShortcut.Register(accel, g.toggle); err != nil {
		if g.current != "" {
			if err := mygo.GlobalShortcut.Register(g.current, g.toggle); err != nil {
				log.Printf("putting the shortcut %s back: %v", g.current, err)
			}
		}
		return err
	}
	g.current = accel
	if g.tray != nil {
		g.tray.SetMenu(trayMenu(g.panel, g.toggle, accel))
		g.tray.SetToolTip("Notefloat — " + accel)
	}
	return nil
}

// openSettings shows the panel with its settings page.
func openSettings(panel *mygo.Window) {
	show(panel)
	if err := OpenSettings.Emit(panel, true); err != nil {
		log.Print(err)
	}
}

// addTray puts the app in the menu bar: with no Dock icon, the tray menu is
// how the user summons the panel, opens the settings and quits the app.
func addTray(panel *mygo.Window, shortcut *globalShortcut) *mygo.Tray {
	shortcut.mu.Lock()
	toggle := shortcut.toggle
	accel := shortcut.current
	shortcut.mu.Unlock()
	tray, err := mygo.NewTray(mygo.TrayOptions{
		ID:             "notefloat",
		Icon:           trayIcon(),
		IconIsTemplate: true,
		ToolTip:        "Notefloat — " + accel,
		Menu:           trayMenu(panel, toggle, accel),
	})
	if err != nil {
		log.Printf("adding the tray icon: %v", err)
		return nil
	}
	return tray
}

func trayMenu(panel *mygo.Window, toggle func(), accel string) *mygo.Menu {
	return mygo.NewMenu([]*mygo.MenuItem{
		{
			Label:       "Show/Hide Notefloat",
			Accelerator: accel,
			Click:       func(*mygo.MenuItem, *mygo.Window) { toggle() },
		},
		{
			Label: "Settings…",
			Click: func(*mygo.MenuItem, *mygo.Window) { openSettings(panel) },
		},
		mygo.Separator(),
		{Label: "Quit Notefloat", Role: mygo.RoleQuit},
	})
}

// trayIcon draws the menu bar icon: the panel icon's node graph, on the 32px
// grid the menu bar hands a template image. macOS tints a template for light
// and dark menu bars, so the ink is black and only the alpha carries the shape.
func trayIcon() []byte {
	const (
		size    = 32
		samples = 4 // per axis; the graph has no straight pixel edges to rely on
		pitch   = 10.0
		dot     = 3.4
		bar     = 2.6
	)
	center := float64(size) / 2
	cols := [3]float64{center - pitch, center, center + pitch}
	rows := [3]float64{center - pitch, center, center + pitch}
	// The same six dots and five bars as the app icon: three across the top,
	// one below the middle of them, one to its right, one below that.
	dots := [][2]float64{
		{cols[0], rows[0]}, {cols[1], rows[0]}, {cols[2], rows[0]},
		{cols[1], rows[1]}, {cols[2], rows[1]},
		{cols[1], rows[2]},
	}
	bars := [][4]float64{
		{cols[0], rows[0], cols[1], rows[0]},
		{cols[1], rows[0], cols[2], rows[0]},
		{cols[1], rows[0], cols[1], rows[1]},
		{cols[1], rows[1], cols[2], rows[1]},
		{cols[1], rows[1], cols[1], rows[2]},
	}
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := range size {
		for x := range size {
			covered := 0
			for sy := 0; sy < samples; sy++ {
				for sx := 0; sx < samples; sx++ {
					px := float64(x) + (float64(sx)+0.5)/samples
					py := float64(y) + (float64(sy)+0.5)/samples
					if graphInk(px, py, dots, bars, dot, bar) {
						covered++
					}
				}
			}
			if covered > 0 {
				a := uint8(255 * covered / (samples * samples))
				img.Set(x, y, color.RGBA{A: a})
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

// graphInk reports whether a point falls inside one of the dots or one of the
// bars. The bars are axis aligned and drawn from centre to centre, so each one
// spans its two centres grown by half the bar thickness.
func graphInk(x, y float64, dots [][2]float64, bars [][4]float64, dot, bar float64) bool {
	for _, d := range dots {
		dx, dy := x-d[0], y-d[1]
		if dx*dx+dy*dy <= dot*dot {
			return true
		}
	}
	half := bar / 2
	for _, b := range bars {
		left, right := math.Min(b[0], b[2])-half, math.Max(b[0], b[2])+half
		top, bottom := math.Min(b[1], b[3])-half, math.Max(b[1], b[3])+half
		if x >= left && x <= right && y >= top && y <= bottom {
			return true
		}
	}
	return false
}
