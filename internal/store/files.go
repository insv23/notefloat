package store

import (
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
)

// where the notes and the pictures live, relative to the app's data directory.
const (
	NotesDirName  = "notes"
	ImagesDirName = "images"
)

// appRoot returns the app's data directory, creating the directories the app
// writes to. It is read on every call rather than kept: Preferences may point
// the app at another directory while it runs.
func AppRoot() (string, error) {
	root, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return "", err
	}
	for _, sub := range []string{NotesDirName, ImagesDirName} {
		if err := os.MkdirAll(filepath.Join(root, sub), 0o755); err != nil {
			return "", err
		}
	}
	return root, nil
}

// defaultAppRoot is the data directory the app uses until the user picks
// another one.
func DefaultAppRoot() (string, error) {
	appData, err := mygo.App.Path(mygo.PathAppData)
	if err != nil {
		return "", err
	}
	return filepath.Join(appData, mygo.App.Name()), nil
}

func ImagesDir() (string, error) {
	root, err := AppRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, ImagesDirName), nil
}

func NotesDir() (string, error) {
	root, err := AppRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, NotesDirName), nil
}

// WriteFileAtomic writes data to a temporary file beside path and renames it
// over path, so that a crash never leaves a half written file.
func WriteFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
