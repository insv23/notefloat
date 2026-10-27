package prefs

import (
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
)

// The actions a shortcut can be bound to. Their values are what settings.json
// and the page call them by.
const (
	ActionTogglePanel   = "togglePanel"
	ActionNewNote       = "newNote"
	ActionNewFolder     = "newFolder"
	ActionPinNote       = "pinNote"
	ActionAddBlockBelow = "addBlockBelow"
	ActionAddBlockAbove = "addBlockAbove"
	ActionSplitBlock    = "splitBlock"
	ActionMoveBlockUp   = "moveBlockUp"
	ActionMoveBlockDown = "moveBlockDown"
	ActionSelectBlock   = "selectBlock"
	ActionToggleTodo    = "toggleTodo"
	ActionToggleLine    = "toggleLineCheck"
	ActionToggleBlock   = "toggleBlockDone"
	ActionFoldBlock     = "toggleBlockFold"
	ActionFoldAllBlocks = "foldAllBlocks"
	ActionPreviousBlock = "previousBlock"
	ActionNextBlock     = "nextBlock"
	ActionSettings      = "settings"
	ActionToggleSidebar = "toggleSidebar"
	ActionFindInNote    = "findInNote"
	ActionFindAll       = "findAll"
)

// The codes a refused shortcut starts with. The page turns one into a sentence
// of its own, so the text after the colon is for the log and may change.
const (
	codeShortcutNoModifier = "shortcut-needs-modifier"
	codeShortcutInUse      = "shortcut-in-use"
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
// is Command-Comma. A label names both directions when the key has two: Show/Hide,
// Pin/Unpin, Toggle. It says more only where the name cannot say it, as a second
// press of Select Block reaching past the block to the whole note.
var shortcutDefs = []ShortcutDef{
	{Action: ActionTogglePanel, Label: "Show/Hide Notefloat", Default: "Alt+V", Global: true},
	{Action: ActionNewNote, Label: "New Note", Default: "Super+N"},
	{Action: ActionNewFolder, Label: "New Folder", Default: "Super+Shift+N"},
	{Action: ActionPinNote, Label: "Pin/Unpin Note", Default: "Super+P"},
	{Action: ActionAddBlockBelow, Label: "Add Block Below", Default: "Super+Enter"},
	{Action: ActionAddBlockAbove, Label: "Add Block Above", Default: "Super+Shift+Enter"},
	{Action: ActionSplitBlock, Label: "Split Block at Cursor", Default: "Alt+Enter"},
	{Action: ActionMoveBlockUp, Label: "Move Block Up", Default: "Alt+Up"},
	{Action: ActionMoveBlockDown, Label: "Move Block Down", Default: "Alt+Down"},
	{Action: ActionSelectBlock, Label: "Select Block, then Whole Note", Default: "Super+A"},
	{Action: ActionToggleTodo, Label: "Toggle Todo Line", Default: "Super+L"},
	{Action: ActionToggleLine, Label: "Toggle Line Check", Default: "Super+Shift+L"},
	{Action: ActionToggleBlock, Label: "Toggle Block Done", Default: "Super+B"},
	{Action: ActionFoldBlock, Label: "Fold/Unfold Block", Default: "Super+D"},
	{Action: ActionFoldAllBlocks, Label: "Fold/Unfold All Blocks", Default: "Super+Shift+D"},
	{Action: ActionPreviousBlock, Label: "Previous Block", Default: "Super+Up"},
	{Action: ActionNextBlock, Label: "Next Block", Default: "Super+Down"},
	{Action: ActionSettings, Label: "Settings", Default: "Super+,"},
	{Action: ActionToggleSidebar, Label: "Show/Hide Sidebar", Default: "Super+S"},
	{Action: ActionFindInNote, Label: "Find in Note", Default: "Super+F"},
	{Action: ActionFindAll, Label: "Search All Notes", Default: "Super+Shift+F"},
}

func shortcutDef(action string) (ShortcutDef, bool) {
	for _, def := range shortcutDefs {
		if def.Action == action {
			return def, true
		}
	}
	return ShortcutDef{}, false
}

// Shortcuts lists the actions the settings page shows, defaults included.
func (p *Preferences) Shortcuts() []ShortcutDef {
	return slices.Clone(shortcutDefs)
}

// SetShortcut binds action to accel. A global shortcut is registered before it
// is saved: when the system refuses it, the old one stays.
func (p *Preferences) SetShortcut(action, accel string) (err error) {
	// A refused shortcut shows on the row that asked for it, and in the log that
	// outlives the row.
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
		return fmt.Errorf("%s: %s is already the shortcut for %s", codeShortcutInUse, accel, label)
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
	return fmt.Errorf("%s: a shortcut that works in every app needs ⌘, ⌃ or ⌥", codeShortcutNoModifier)
}

// SetRecording lets go of the global shortcut while the settings wait for the
// key that is to become it, so that the key it holds reaches the page instead of
// the system hiding the panel the user is typing in.
func (p *Preferences) SetRecording(recording bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.applyGlobal == nil {
		return nil
	}
	accel := ""
	if !recording {
		accel = p.settings.Shortcuts[ActionTogglePanel]
	}
	return p.applyGlobal(accel)
}
