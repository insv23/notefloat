package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/egoist/mygo"
)

// settingsFile is where the app keeps the user's choices. It sits in the
// default user data directory whatever NotesDir says, so that the setting that
// moves the data cannot move itself away with it.
const settingsFile = "settings.json"

// The actions a shortcut can be bound to. Their values are what settings.json
// and the page call them by.
const (
	actionTogglePanel   = "togglePanel"
	actionNewNote       = "newNote"
	actionNewFolder     = "newFolder"
	actionPinNote       = "pinNote"
	actionMoveBlockUp   = "moveBlockUp"
	actionMoveBlockDown = "moveBlockDown"
	actionSettings      = "settings"
	actionToggleSidebar = "toggleSidebar"
	actionFindInNote    = "findInNote"
	actionFindAll       = "findAll"
)

// ShortcutDef is one shortcut the user can change: what it does, the keys it
// starts with, and whether it works in every app or only in this one.
type ShortcutDef struct {
	Action  string `json:"action"`
	Label   string `json:"label"`
	Default string `json:"default"`
	// Global shortcuts are registered with the system and work while another
	// app is in front. The others are matched by the page while the panel has
	// the keyboard.
	Global bool `json:"global"`
}

// shortcutDefs lists the shortcuts in the order the settings page shows them.
// Accelerators are in mygo's syntax: Super is Command on macOS, and "Super+,"
// is Command-Comma.
var shortcutDefs = []ShortcutDef{
	{Action: actionTogglePanel, Label: "Show/Hide Notefloat", Default: "Alt+V", Global: true},
	{Action: actionNewNote, Label: "New Note", Default: "Super+N"},
	{Action: actionNewFolder, Label: "New Folder", Default: "Super+Shift+N"},
	{Action: actionPinNote, Label: "Pin/Unpin Note", Default: "Super+P"},
	{Action: actionMoveBlockUp, Label: "Move Block Up", Default: "Alt+Up"},
	{Action: actionMoveBlockDown, Label: "Move Block Down", Default: "Alt+Down"},
	{Action: actionSettings, Label: "Settings", Default: "Super+,"},
	{Action: actionToggleSidebar, Label: "Toggle Sidebar", Default: "Super+B"},
	{Action: actionFindInNote, Label: "Find in Note", Default: "Super+F"},
	{Action: actionFindAll, Label: "Search All Notes", Default: "Super+Shift+F"},
}

func shortcutDef(action string) (ShortcutDef, bool) {
	for _, def := range shortcutDefs {
		if def.Action == action {
			return def, true
		}
	}
	return ShortcutDef{}, false
}

// Settings is what the user can change. It crosses to the page as it is.
type Settings struct {
	OpenAtLogin bool `json:"openAtLogin"`
	// NotesDir is where the notes live; empty means the default user data
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

// Preferences is the store of Settings, and applies the ones that reach past
// the page: the login item, the global shortcut, the panel's opacity, and the
// directory the notes live in.
type Preferences struct {
	mu       sync.Mutex
	settings Settings
	loaded   bool
	// applyGlobal puts the global shortcut in place of the one registered
	// now, and leaves the old one in place when it fails. main sets it once
	// the panel exists.
	applyGlobal func(accel string) error
	// panel is the notes window; main sets it once it exists.
	panel *mygo.Window
	// notes is the store whose library is read from the data directory: the
	// settings that move the directory have to make it read again.
	notes *Notes
}

func newPreferences(notes *Notes) *Preferences {
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

// startup reads settings.json, or starts from the defaults. It is called
// before the app is ready, so that the notes directory is known before the
// first note is read.
func (p *Preferences) startup() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.load()
}

// notesDir is the directory the notes live in, empty when it is the default
// one.
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
// added by a later version and a field a version did not write still have
// their default.
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
	return merged
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
	return writeFileAtomic(path, body)
}

// apply puts the settings that live outside the page in place. main calls it
// once the panel exists.
func (p *Preferences) apply() {
	p.mu.Lock()
	settings := p.settings
	panel := p.panel
	p.mu.Unlock()
	if panel != nil {
		panel.SetOpacity(settings.Opacity)
	}
}

// Shortcuts lists the actions the settings page shows, defaults included.
func (p *Preferences) Shortcuts() []ShortcutDef {
	return slices.Clone(shortcutDefs)
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

// SetShortcut binds action to accel. A global shortcut is registered before it
// is saved: when the system refuses it, the old one stays.
func (p *Preferences) SetShortcut(action, accel string) (err error) {
	// A refused shortcut shows on the row that asked for it, and in the log
	// that outlives the row.
	defer func() {
		if err != nil {
			log.Printf("binding %s to %q: %v", action, accel, err)
		}
	}()
	accel = strings.TrimSpace(accel)
	if accel == "" {
		return errors.New("a shortcut needs at least one key")
	}
	def, ok := shortcutDef(action)
	if !ok {
		return fmt.Errorf("unknown shortcut %q", action)
	}
	if def.Global {
		if err := checkGlobal(accel); err != nil {
			return err
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(); err != nil {
		return err
	}
	for other, bound := range p.settings.Shortcuts {
		if other == action || !strings.EqualFold(bound, accel) {
			continue
		}
		label := other
		if def, ok := shortcutDef(other); ok {
			label = def.Label
		}
		return fmt.Errorf("%s is already the shortcut for %s", accel, label)
	}
	old := p.settings.Shortcuts[action]
	if strings.EqualFold(old, accel) {
		return nil
	}
	if def.Global && p.applyGlobal != nil {
		if err := p.applyGlobal(accel); err != nil {
			return err
		}
	}
	p.settings.Shortcuts[action] = accel
	if err := p.save(); err != nil {
		p.settings.Shortcuts[action] = old
		if def.Global && p.applyGlobal != nil {
			if undoErr := p.applyGlobal(old); undoErr != nil {
				log.Printf("putting %s back: %v", old, undoErr)
			}
		}
		return err
	}
	return nil
}

// ResetShortcut puts one shortcut back to its default.
func (p *Preferences) ResetShortcut(action string) error {
	def, ok := shortcutDef(action)
	if !ok {
		return fmt.Errorf("unknown shortcut %q", action)
	}
	return p.SetShortcut(action, def.Default)
}

// ResetShortcuts puts every shortcut back to its default.
func (p *Preferences) ResetShortcuts() error {
	for _, def := range shortcutDefs {
		if err := p.SetShortcut(def.Action, def.Default); err != nil {
			return err
		}
	}
	return nil
}

// checkGlobal refuses a global shortcut with no modifier at all: a bare key
// registered with the system would take that key from every other app. Which of
// Command, Control and Option does that is the user's call, as it is in every
// app that offers a system wide shortcut.
func checkGlobal(accel string) error {
	for _, part := range strings.Split(strings.ToLower(accel), "+") {
		switch strings.TrimSpace(part) {
		case "alt", "option", "altgr", "ctrl", "control", "cmdorctrl", "commandorcontrol",
			"super", "command", "cmd", "meta":
			return nil
		}
	}
	return errors.New("a shortcut that works in every app needs ⌘, ⌃ or ⌥")
}

// SetRecording lets go of the global shortcut while the settings wait for the
// key that is to become it, so that the key it holds reaches the page instead
// of the system hiding the panel the user is typing in.
func (p *Preferences) SetRecording(recording bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.applyGlobal == nil {
		return nil
	}
	accel := ""
	if !recording {
		accel = p.settings.Shortcuts[actionTogglePanel]
	}
	return p.applyGlobal(accel)
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

// SetSidebarHidden remembers the sidebar closed, so that the panel opens the
// same way it was left.
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

// ChooseDataDir asks for a directory, copies the notes into it and switches
// the app to it. It returns the settings unchanged when the user cancels.
func (p *Preferences) ChooseDataDir(ctx context.Context) (Settings, error) {
	parent := mygo.CallerWindow(ctx)
	dirs, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:            parent,
		Title:             "Choose where Notefloat keeps your notes",
		ButtonLabel:       "Choose",
		Message:           "The notes and pictures there are copied to the folder you pick.",
		Directory:         true,
		CreateDirectories: true,
	})
	if err != nil || len(dirs) == 0 {
		return p.Get()
	}
	target := filepath.Clean(dirs[0])
	current, err := appRoot()
	if err != nil {
		return Settings{}, err
	}
	if target == current {
		return p.Get()
	}
	// Notes copied into the notes directory they come from would copy
	// themselves, so neither directory may hold the other.
	if within(target, current) || within(current, target) {
		return Settings{}, errors.New("pick a folder outside " + current)
	}
	if libraryAt(target) {
		return Settings{}, fmt.Errorf("%s already holds Notefloat notes", target)
	}
	// Switching asks what happens to the notes already there: the user may
	// want a copy in the new place, may want them moved, or may want to start
	// empty in it.
	choice, err := mygo.Dialog.Message(mygo.MessageOptions{
		Parent:        parent,
		Type:          mygo.MessageQuestion,
		Title:         "Use this folder for your notes?",
		Message:       "Notefloat keeps your notes in " + current + ".",
		Detail:        "Choose what happens to them in " + target + ".",
		Buttons:       []string{"Copy Notes", "Move Notes", "Start Empty", "Cancel"},
		DefaultButton: 0,
		CancelButton:  3,
	})
	if err != nil {
		return Settings{}, err
	}
	switch choice.Button {
	case 0:
		if err := copyLibrary(current, target); err != nil {
			return Settings{}, fmt.Errorf("copying the notes: %w", err)
		}
	case 1:
		if err := copyLibrary(current, target); err != nil {
			return Settings{}, fmt.Errorf("copying the notes: %w", err)
		}
		trashLibrary(current)
	case 2:
		// Start Empty: the old notes stay where they are and the new folder
		// gets a library of its own.
	case 3:
		return p.Get()
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(); err != nil {
		return Settings{}, err
	}
	defaultDir, err := defaultAppRoot()
	if err != nil {
		return Settings{}, err
	}
	// An empty NotesDir means the default directory, which is what the app
	// goes back to when the user picks it again.
	stored := target
	if target == defaultDir {
		stored = ""
	}
	p.settings.NotesDir = stored
	if err := p.save(); err != nil {
		return Settings{}, err
	}
	mygo.App.SetPath(mygo.PathUserData, stored)
	if p.notes != nil {
		p.notes.reset()
	}
	serveImages()
	return p.settings, nil
}

// trashLibrary moves the notes of a directory to the Trash, once they were
// copied somewhere else. settings.json stays: the app keeps reading it, and it
// is not part of the notes.
func trashLibrary(dir string) {
	for _, path := range []string{
		filepath.Join(dir, notesDirName),
		filepath.Join(dir, imagesDirName),
		filepath.Join(dir, libraryFile),
	} {
		if _, err := os.Stat(path); err != nil {
			continue
		}
		if err := mygo.Shell.TrashItem(path); err != nil {
			log.Printf("trashing %s: %v", path, err)
		}
	}
}

// within reports whether dir is base or a directory under it.
func within(dir, base string) bool {
	rel, err := filepath.Rel(base, dir)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// libraryAt reports whether dir already holds notes of this app.
func libraryAt(dir string) bool {
	for _, name := range []string{libraryFile, notesDirName, imagesDirName} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return true
		}
	}
	return false
}

// copyLibrary copies notes, pictures and the library file into dir. Other
// files of the old directory, such as window-state.json, are left behind.
func copyLibrary(from, to string) error {
	if err := os.MkdirAll(to, 0o755); err != nil {
		return err
	}
	for _, name := range []string{notesDirName, imagesDirName} {
		if err := copyTree(filepath.Join(from, name), filepath.Join(to, name)); err != nil {
			return err
		}
	}
	body, err := os.ReadFile(filepath.Join(from, libraryFile))
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(to, libraryFile), body)
}

func copyTree(from, to string) error {
	return filepath.WalkDir(from, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		rel, err := filepath.Rel(from, path)
		if err != nil {
			return err
		}
		return copyFile(path, filepath.Join(to, rel))
	})
}

func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// RevealDataDir shows the notes in the Finder.
func (p *Preferences) RevealDataDir() error {
	root, err := appRoot()
	if err != nil {
		return err
	}
	mygo.Shell.ShowItemInFolder(root)
	return nil
}

// AppInfo names the app for the settings page's About section.
type AppInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	DataDir string `json:"dataDir"`
}

// About returns the app's name, version and where it keeps the notes.
func (p *Preferences) About() (AppInfo, error) {
	root, err := appRoot()
	if err != nil {
		return AppInfo{}, err
	}
	return AppInfo{Name: mygo.App.Name(), Version: mygo.App.Version(), DataDir: root}, nil
}
