package prefs

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/egoist/mygo"

	"notefloat/internal/store"
)

// settingsFile is where the app keeps the user's choices. It sits in the default
// user data directory whatever NotesDir says, so that the setting that moves the
// data cannot move itself away with it.
const settingsFile = "settings.json"

// Settings is what the user can change. It crosses to the page as it is.
type Settings struct {
	OpenAtLogin bool `json:"openAtLogin"`
	// notesDir is where the notes live; empty means the default user data
	// directory.
	NotesDir string `json:"notesDir"`
	// Shortcuts holds every action, the ones left at their default included.
	Shortcuts map[string]string `json:"shortcuts"`
	// Opacity of the panel, between 0.4 and 1.
	Opacity float64 `json:"opacity"`
	// SidebarHidden remembers the sidebar closed.
	SidebarHidden bool `json:"sidebarHidden"`
}

// DefaultSettings is the state of an install the user has not changed.
func DefaultSettings() Settings {
	shortcuts := make(map[string]string, len(shortcutDefs))
	for _, def := range shortcutDefs {
		shortcuts[def.Action] = def.Default
	}
	// The panel floats, so that it shows over the app the user is in; see
	// newPanel in main.go.
	return Settings{Shortcuts: shortcuts, Opacity: 1}
}

// Preferences is the store of Settings, and applies the ones that reach past the
// page: the login item, the global shortcut, the panel's opacity, and the
// directory the notes live in.
type Preferences struct {
	mu       sync.Mutex
	settings Settings
	loaded   bool
	// applyGlobal puts the global shortcut in place of the one registered now,
	// and leaves the old one in place when it fails. main sets it once the panel
	// exists.
	applyGlobal func(accel string) error
	// panel is the notes window; main sets it once it exists.
	panel *mygo.Window
	// notes is the store whose library is read from the data directory: the
	// settings that move the directory have to make it read again.
	notes *store.Notes
}

func New(notes *store.Notes) *Preferences {
	return &Preferences{settings: DefaultSettings(), notes: notes}
}

// settingsPath is where settings.json lives, which is the default user data
// directory even while the notes live somewhere else.
func settingsPath() (string, error) {
	appData, err := mygo.App.Path(mygo.PathAppData)
	if err != nil {
		return "", err
	}
	return filepath.Join(appData, mygo.App.Name(), settingsFile), nil
}

// startup reads settings.json, or starts from the defaults. It is called before
// the app is ready, so that the notes directory is known before the first note is
// read.
func (p *Preferences) startup() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.load()
}

// notesDir is where the notes live, empty when it is the default one.
func (p *Preferences) notesDir() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.settings.NotesDir
}

// accel is the accelerator bound to action now.
func (p *Preferences) accel(action string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.settings.Shortcuts[action]
}

// useWindow gives Preferences the panel it sets the opacity and the level of.
func (p *Preferences) useWindow(panel *mygo.Window) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.panel = panel
}

// useGlobal gives Preferences the way to register the global shortcut.
func (p *Preferences) useGlobal(fn func(string) error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.applyGlobal = fn
}

func (p *Preferences) load() error {
	if p.loaded {
		return nil
	}
	p.loaded = true
	path, err := settingsPath()
	if err != nil {
		return err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("reading %s: %v", settingsFile, err)
		}
		return nil
	}
	var stored Settings
	if err := json.Unmarshal(body, &stored); err != nil {
		log.Printf("reading %s: %v, starting from the defaults", settingsFile, err)
		return nil
	}
	p.settings = mergeSettings(DefaultSettings(), stored)
	return nil
}

// mergeSettings lays a stored Settings over the defaults, so that a shortcut
// added by a later version and a field a version did not write still have their
// default.
func mergeSettings(defaults, stored Settings) Settings {
	merged := defaults
	merged.OpenAtLogin = stored.OpenAtLogin
	merged.NotesDir = stored.NotesDir
	if stored.Opacity > 0 {
		merged.Opacity = min(max(stored.Opacity, 0.4), 1)
	}
	merged.SidebarHidden = stored.SidebarHidden
	for action, accel := range stored.Shortcuts {
		// A shortcut of an action a version dropped stays out, so that the page
		// binds nothing it cannot run.
		if _, known := shortcutDef(action); !known {
			continue
		}
		if strings.TrimSpace(accel) != "" {
			merged.Shortcuts[action] = accel
		}
	}
	freeDefaultKeys(&merged)
	return merged
}

// freeDefaultKeys gives every default key back to the action it belongs to. A
// later version can add an action whose default is a key an older settings.json
// had bound to something else: without this, one press would run both, and the
// row that shows the new default would be a lie.
func freeDefaultKeys(settings *Settings) {
	owner := make(map[string]string, len(shortcutDefs))
	for _, def := range shortcutDefs {
		owner[shortcutKey(def.Default)] = def.Action
	}
	for action, accel := range settings.Shortcuts {
		def, known := shortcutDef(action)
		if !known || strings.EqualFold(accel, def.Default) {
			continue
		}
		if owner[shortcutKey(accel)] == "" {
			continue
		}
		settings.Shortcuts[action] = def.Default
	}
}

// shortcutKey puts an accelerator in the shape two of them compare in.
func shortcutKey(accel string) string {
	return strings.ToUpper(strings.Join(strings.Fields(accel), ""))
}

func (p *Preferences) save() error {
	path, err := settingsPath()
	if err != nil {
		return err
	}
	body, err := json.MarshalIndent(p.settings, "", "  ")
	if err != nil {
		return err
	}
	return store.WriteFileAtomic(path, body)
}

// apply puts the settings that live outside the page in place. main calls it once
// the panel exists.
func (p *Preferences) apply() {
	p.mu.Lock()
	settings := p.settings
	panel := p.panel
	p.mu.Unlock()
	if panel != nil {
		panel.SetOpacity(settings.Opacity)
	}
}

// Get returns the settings in force.
func (p *Preferences) Get() (Settings, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(); err != nil {
		return Settings{}, err
	}
	settings := p.settings
	settings.Shortcuts = make(map[string]string, len(p.settings.Shortcuts))
	for action, accel := range p.settings.Shortcuts {
		settings.Shortcuts[action] = accel
	}
	// The login item is the system's to keep, and can be turned off in System
	// Settings behind the app's back.
	settings.OpenAtLogin = mygo.App.OpenAtLogin()
	return settings, nil
}

// SetOpenAtLogin starts the app at login, or stops it from doing so.
func (p *Preferences) SetOpenAtLogin(open bool) error {
	if err := mygo.App.SetOpenAtLogin(open); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(); err != nil {
		return err
	}
	p.settings.OpenAtLogin = open
	return p.save()
}

// SetOpacity sets how see-through the panel is, and remembers it.
func (p *Preferences) SetOpacity(opacity float64) error {
	opacity = min(max(opacity, 0.4), 1)
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(); err != nil {
		return err
	}
	panel := p.panel
	p.settings.Opacity = opacity
	if panel != nil {
		panel.SetOpacity(opacity)
	}
	return p.save()
}

// SetSidebarHidden remembers the sidebar closed, so that the panel opens the same
// way it was left.
func (p *Preferences) SetSidebarHidden(hidden bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(); err != nil {
		return err
	}
	if p.settings.SidebarHidden == hidden {
		return nil
	}
	p.settings.SidebarHidden = hidden
	return p.save()
}

// AppInfo names the app for the settings page's About section.
type AppInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	DataDir string `json:"dataDir"`
}

// About returns the app's name, version and where it keeps the notes.
func (p *Preferences) About() (AppInfo, error) {
	root, err := store.AppRoot()
	if err != nil {
		return AppInfo{}, err
	}
	return AppInfo{Name: mygo.App.Name(), Version: mygo.App.Version(), DataDir: root}, nil
}

// The page reaches Preferences through mygo, which binds the methods it can
// carry over JSON. These are the ones main needs before the page runs: they
// take the value or a Go function, so they stay out of the binding.

// Startup reads settings.json, or starts from the defaults.
func Startup(p *Preferences) error { return p.startup() }

// Apply puts the settings that live outside the page in place.
func Apply(p *Preferences) { p.apply() }

// UseWindow gives Preferences the panel its opacity and level belong to.
func UseWindow(p *Preferences, panel *mygo.Window) { p.useWindow(panel) }

// UseGlobal gives Preferences the way to register the global shortcut.
func UseGlobal(p *Preferences, fn func(string) error) { p.useGlobal(fn) }

// NotesDir is the directory the notes live in.
func NotesDir(p *Preferences) string { return p.notesDir() }

// Accel is the accelerator bound to action now.
func Accel(p *Preferences, action string) string { return p.accel(action) }
