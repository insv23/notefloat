package prefs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"

	"notefloat/internal/pictures"
	"notefloat/internal/store"
)

// ChooseDataDir asks for a directory, copies the notes into it and switches the
// app to it. It returns the settings unchanged when the user cancels.
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
	current, err := store.AppRoot()
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
	// Switching asks what happens to the notes already there: the user may want
	// a copy in the new place, may want them moved, or may want to start empty
	// in it.
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
		// Start Empty: the old notes stay where they are and the new folder gets
		// a library of its own.
	case 3:
		return p.Get()
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(); err != nil {
		return Settings{}, err
	}
	defaultDir, err := store.DefaultAppRoot()
	if err != nil {
		return Settings{}, err
	}
	// An empty NotesDir means the default directory, which is what the app goes
	// back to when the user picks it again.
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
		p.notes.Reset()
	}
	pictures.Serve()
	return p.settings, nil
}

// RevealDataDir shows the notes in the Finder.
func (p *Preferences) RevealDataDir() error {
	root, err := store.AppRoot()
	if err != nil {
		return err
	}
	mygo.Shell.ShowItemInFolder(root)
	return nil
}

// trashLibrary moves the notes of a directory to the Trash, once they were
// copied somewhere else. settings.json stays: the app keeps reading it, and it is
// not part of the notes.
func trashLibrary(dir string) {
	for _, path := range []string{
		filepath.Join(dir, store.NotesDirName),
		filepath.Join(dir, store.ImagesDirName),
		filepath.Join(dir, store.LibraryFile),
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
	for _, name := range []string{store.LibraryFile, store.NotesDirName, store.ImagesDirName} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return true
		}
	}
	return false
}

// copyLibrary copies notes, pictures and the library file into dir. Other files
// of the old directory, such as window-state.json, are left behind.
func copyLibrary(from, to string) error {
	if err := os.MkdirAll(to, 0o755); err != nil {
		return err
	}
	for _, name := range []string{store.NotesDirName, store.ImagesDirName} {
		if err := copyTree(filepath.Join(from, name), filepath.Join(to, name)); err != nil {
			return err
		}
	}
	body, err := os.ReadFile(filepath.Join(from, store.LibraryFile))
	if err != nil {
		return err
	}
	return store.WriteFileAtomic(filepath.Join(to, store.LibraryFile), body)
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
