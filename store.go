package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// Everything the app keeps lives in one directory of the user's:
//
//	<userData>/notes/<buffer>.txt   one plain text file per buffer
//	<userData>/images/<yyyy-mm>/<sha256>.<ext>   pasted pictures
//	<userData>/library.json        the buffers and which one was open
const (
	notesDirName  = "notes"
	imagesDirName = "images"
	libraryFile   = "library.json"
	imageScheme   = "notefloat-img"
)

// appRoot returns the app's data directory, creating the directories the app
// writes to.
var appRoot = sync.OnceValues(func() (string, error) {
	root, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return "", err
	}
	for _, sub := range []string{notesDirName, imagesDirName} {
		if err := os.MkdirAll(filepath.Join(root, sub), 0o755); err != nil {
			return "", err
		}
	}
	return root, nil
})

func imagesDir() (string, error) {
	root, err := appRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, imagesDirName), nil
}

func notesDir() (string, error) {
	root, err := appRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, notesDirName), nil
}

// Buffer is one note: a plain text file with a title.
type Buffer struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// Library is what the page needs to draw the sidebar: the buffers, which one
// was open, and where the notes and pictures live.
type Library struct {
	Buffers   []Buffer `json:"buffers"`
	Active    string   `json:"active"`
	DataDir   string   `json:"dataDir"`
	ImagesDir string   `json:"imagesDir"`
}

type libraryFileContent struct {
	Buffers []Buffer `json:"buffers"`
	Active  string   `json:"active"`
}

// Notes is the store the page calls. Every write is atomic: the file is
// written beside its destination and renamed, so a crash never leaves a half
// written note.
type Notes struct {
	mu      sync.Mutex
	library libraryFileContent
	loaded  bool
}

func (n *Notes) loadLibrary() error {
	if n.loaded {
		return nil
	}
	root, err := appRoot()
	if err != nil {
		return err
	}
	body, err := os.ReadFile(filepath.Join(root, libraryFile))
	if err == nil {
		if err := json.Unmarshal(body, &n.library); err != nil {
			log.Printf("reading %s: %v, starting a new library", libraryFile, err)
			n.library = libraryFileContent{}
		}
	}
	n.loaded = true
	if len(n.library.Buffers) == 0 {
		buffer, err := n.create("笔记 1")
		if err != nil {
			return err
		}
		n.library.Buffers = []Buffer{buffer}
		n.library.Active = buffer.ID
	}
	if n.library.Active == "" {
		n.library.Active = n.library.Buffers[0].ID
	}
	return n.saveLibrary()
}

func (n *Notes) saveLibrary() error {
	root, err := appRoot()
	if err != nil {
		return err
	}
	body, err := json.MarshalIndent(n.library, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(root, libraryFile), body)
}

// Library returns the buffers of the app.
func (n *Notes) Library() (Library, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return Library{}, err
	}
	root, err := appRoot()
	if err != nil {
		return Library{}, err
	}
	return Library{
		Buffers:   append([]Buffer(nil), n.library.Buffers...),
		Active:    n.library.Active,
		DataDir:   root,
		ImagesDir: filepath.Join(root, imagesDirName),
	}, nil
}

// Load returns the text of a buffer.
func (n *Notes) Load(id string) (string, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	dir, err := notesDir()
	if err != nil {
		return "", err
	}
	body, err := os.ReadFile(filepath.Join(dir, id+".txt"))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return string(body), err
}

// Save writes a buffer's text and title.
func (n *Notes) Save(id, title, text string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return err
	}
	dir, err := notesDir()
	if err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(dir, id+".txt"), []byte(text)); err != nil {
		return err
	}
	for i := range n.library.Buffers {
		if n.library.Buffers[i].ID == id {
			if n.library.Buffers[i].Title == title {
				return nil
			}
			n.library.Buffers[i].Title = title
			return n.saveLibrary()
		}
	}
	return fmt.Errorf("unknown buffer %q", id)
}

// Create adds a buffer and returns it.
func (n *Notes) Create(title string) (Buffer, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return Buffer{}, err
	}
	buffer, err := n.create(title)
	if err != nil {
		return Buffer{}, err
	}
	n.library.Buffers = append(n.library.Buffers, buffer)
	n.library.Active = buffer.ID
	if err := n.saveLibrary(); err != nil {
		return Buffer{}, err
	}
	return buffer, nil
}

func (n *Notes) create(title string) (Buffer, error) {
	dir, err := notesDir()
	if err != nil {
		return Buffer{}, err
	}
	id := newID()
	if err := writeFileAtomic(filepath.Join(dir, id+".txt"), nil); err != nil {
		return Buffer{}, err
	}
	return Buffer{ID: id, Title: title}, nil
}

// Remove deletes a buffer's file and forgets it. Pictures it referred to are
// left to the sweep, which waits before trashing anything, so that an undo of
// the deletion would still find them.
func (n *Notes) Remove(id string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return err
	}
	if len(n.library.Buffers) <= 1 {
		return errors.New("the last buffer stays")
	}
	at := -1
	for i, buffer := range n.library.Buffers {
		if buffer.ID == id {
			at = i
			break
		}
	}
	if at < 0 {
		return fmt.Errorf("unknown buffer %q", id)
	}
	n.library.Buffers = append(n.library.Buffers[:at], n.library.Buffers[at+1:]...)
	if n.library.Active == id {
		n.library.Active = n.library.Buffers[max(0, at-1)].ID
	}
	dir, err := notesDir()
	if err != nil {
		return err
	}
	if err := mygo.Shell.TrashItem(filepath.Join(dir, id+".txt")); err != nil {
		log.Printf("trashing the note %s: %v", id, err)
	}
	return n.saveLibrary()
}

// Activate remembers which buffer was open, so that the app opens it again.
func (n *Notes) Activate(id string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return err
	}
	n.library.Active = id
	return n.saveLibrary()
}

// Images stores the pictures pasted into a note.
type Images struct {
	mu sync.Mutex
}

// Save writes a pasted picture and returns its path, which the note then holds
// as plain text. The name is the SHA-256 of the bytes, so pasting the same
// picture twice reuses one file, and a note dropping its reference cannot pull
// a file another note still points at.
func (i *Images) Save(data string) (string, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return "", fmt.Errorf("decoding the picture: %w", err)
	}
	if len(raw) == 0 {
		return "", errors.New("the picture is empty")
	}
	root, err := imagesDir()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	name := hex.EncodeToString(sum[:]) + imageExt(raw)
	month := time.Now().Format("2006-01")
	dir := filepath.Join(root, month)
	path := filepath.Join(dir, name)
	if _, statErr := os.Stat(path); statErr == nil {
		// The picture is already stored: keep its clock running so that the
		// sweep does not trash it soon after this paste.
		now := time.Now()
		_ = os.Chtimes(path, now, now)
		return path, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := writeFileAtomic(path, raw); err != nil {
		return "", err
	}
	return path, nil
}

// imageExt picks the extension from the bytes rather than from what the
// clipboard claims, so that a renamed or mislabelled file still opens.
func imageExt(raw []byte) string {
	switch http.DetectContentType(raw) {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/heic", "image/heif":
		return ".heic"
	default:
		return ".png"
	}
}

func newID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

// writeFileAtomic writes data to a temporary file beside path and renames it
// over path.
func writeFileAtomic(path string, data []byte) error {
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

// serveImages lets the page show a picture by its path: the note keeps the
// absolute path, and the page asks imageScheme for the part after images/.
func serveImages() {
	dir, err := imagesDir()
	if err != nil {
		log.Printf("serving the pictures: %v", err)
		return
	}
	if err := mygo.Protocol.Handle(imageScheme, mygo.FileServer(os.DirFS(dir))); err != nil {
		log.Printf("serving the pictures: %v", err)
	}
}
