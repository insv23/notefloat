package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/egoist/mygo"
)

// Everything the app keeps lives in one directory of the user's:
//
//	<userData>/notes/<buffer>.txt    one plain text file per note
//	<userData>/images/<sha256>.<ext> pasted pictures, flat, named by content
//	<userData>/library.json          the folders, their notes and which one was open
//
// The notes are files of one flat directory whatever folder they show in:
// folders are an arrangement in library.json, so moving a note between them
// never moves a file, and a note file stays readable on its own.
const LibraryFile = "library.json"

// defaultFolderTitle names the folder the notes of an install without folders
// end up in.
const defaultFolderTitle = "Notes"

// newNoteTitle titles a note the user did not name yet.
const newNoteTitle = "Untitled"

// Buffer is one note: a plain text file with a title.
type Buffer struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Pinned notes show up in the sidebar's Pinned section as well as in their
	// own folder.
	Pinned bool `json:"pinned,omitempty"`
}

// Folder groups notes, as a project does. Its notes stay in file order here:
// the order of Buffers is the order the sidebar shows them in.
type Folder struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Buffers []Buffer `json:"buffers"`
}

// Library is what the page needs to draw the sidebar: the folders, which note
// was open, and where the notes and pictures live.
type Library struct {
	Folders   []Folder `json:"folders"`
	Active    string   `json:"active"`
	DataDir   string   `json:"dataDir"`
	ImagesDir string   `json:"imagesDir"`
}

type libraryFileContent struct {
	Folders []Folder `json:"folders"`
	Active  string   `json:"active"`
	// Buffers is the layout of an install from before folders: one flat list of
	// notes. It is moved into Folders on the first read.
	Buffers []Buffer `json:"buffers,omitempty"`
	// Done is what an older version kept here: which blocks of a note the user
	// finished, by note ID, one flag per block in the note's order. The flags
	// now live on the separator that closes each block, and this is read once
	// to put them there; see migrateDone.
	Done map[string][]bool `json:"done,omitempty"`
	// Positions holds where the caret was in a note, by note ID, as an offset
	// into its text. A note read from the top needs no entry.
	Positions map[string]int `json:"positions,omitempty"`
}

// Notes is the store the page calls. Every write is atomic: the file is written
// beside its destination and renamed, so a crash never leaves a half written
// note.
type Notes struct {
	mu      sync.Mutex
	library libraryFileContent
	loaded  bool
}

// Reset forgets the library read from disk, so that the next call reads it from
// whichever directory the app points at then.
func (n *Notes) Reset() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.library = libraryFileContent{}
	n.loaded = false
}

func (n *Notes) loadLibrary() error {
	if n.loaded {
		return nil
	}
	root, err := AppRoot()
	if err != nil {
		return err
	}
	body, err := os.ReadFile(filepath.Join(root, LibraryFile))
	if err == nil {
		if err := json.Unmarshal(body, &n.library); err != nil {
			log.Printf("reading %s: %v, starting a new library", LibraryFile, err)
			n.library = libraryFileContent{}
		}
	}
	n.loaded = true
	if len(n.library.Folders) == 0 && len(n.library.Buffers) > 0 {
		n.library.Folders = []Folder{{
			ID:      newID(),
			Title:   defaultFolderTitle,
			Buffers: n.library.Buffers,
		}}
	}
	n.library.Buffers = nil
	if len(n.library.Folders) == 0 {
		folder, buffer, err := n.createFolder(defaultFolderTitle)
		if err != nil {
			return err
		}
		folder.Buffers = []Buffer{buffer}
		n.library.Folders = []Folder{folder}
		n.library.Active = buffer.ID
	}
	if n.library.Active == "" {
		n.library.Active = n.firstNote()
	}
	if err := n.ensureNote(); err != nil {
		return err
	}
	n.migrateDone()
	return n.saveLibrary()
}

// migrateDone carries the finish flags of an older library into the notes
// themselves, where a mark stays with its block whatever happens around it, and
// then forgets them. A note whose file is gone takes its flags with it.
func (n *Notes) migrateDone() {
	if len(n.library.Done) == 0 {
		return
	}
	dir, err := NotesDir()
	if err != nil {
		log.Printf("moving the finish marks into the notes: %v", err)
		return
	}
	for id, done := range n.library.Done {
		path := filepath.Join(dir, id+".txt")
		body, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			// The note went away; the flags go with it.
			delete(n.library.Done, id)
			continue
		}
		if err != nil {
			log.Printf("reading the finish marks of %s: %v", id, err)
			continue
		}
		if text, changed := stampedDone(string(body), done); changed {
			if err := WriteFileAtomic(path, []byte(text)); err != nil {
				log.Printf("writing the finish marks of %s: %v", id, err)
				continue
			}
		}
		delete(n.library.Done, id)
	}
	if len(n.library.Done) == 0 {
		n.library.Done = nil
	}
}

// stampedDone puts a block's finish mark on the separator that closes it, by
// the block's place from the top of the note.
func stampedDone(text string, done []bool) (string, bool) {
	lines := strings.Split(text, "\n")
	changed := false
	block := 0
	for number, line := range lines {
		if !blockSeparator.MatchString(line) {
			continue
		}
		if block < len(done) && done[block] && !strings.Contains(line, "|done") {
			lines[number] = line + "|done"
			changed = true
		}
		block++
	}
	return strings.Join(lines, "\n"), changed
}

// ensureNote puts an empty note back when the last one went away, so that the
// panel always has a note to type in.
func (n *Notes) ensureNote() error {
	if n.firstNote() != "" {
		return nil
	}
	buffer, err := n.create(newNoteTitle)
	if err != nil {
		return err
	}
	n.library.Folders[0].Buffers = append(n.library.Folders[0].Buffers, buffer)
	n.library.Active = buffer.ID
	return nil
}

func (n *Notes) saveLibrary() error {
	root, err := AppRoot()
	if err != nil {
		return err
	}
	body, err := json.MarshalIndent(n.library, "", "  ")
	if err != nil {
		return err
	}
	return WriteFileAtomic(filepath.Join(root, LibraryFile), body)
}

// firstNote returns the ID of the first note of the first folder that has one.
func (n *Notes) firstNote() string {
	for _, folder := range n.library.Folders {
		if len(folder.Buffers) > 0 {
			return folder.Buffers[0].ID
		}
	}
	return ""
}

// locate finds a note: the folder and the note's place in it.
func (n *Notes) locate(id string) (folder, at int, ok bool) {
	for fi := range n.library.Folders {
		if bi := slices.IndexFunc(n.library.Folders[fi].Buffers, func(b Buffer) bool { return b.ID == id }); bi >= 0 {
			return fi, bi, true
		}
	}
	return 0, 0, false
}

func (n *Notes) folderIndex(id string) int {
	return slices.IndexFunc(n.library.Folders, func(f Folder) bool { return f.ID == id })
}

// Library returns the folders of the app.
func (n *Notes) Library() (Library, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return Library{}, err
	}
	root, err := AppRoot()
	if err != nil {
		return Library{}, err
	}
	folders := make([]Folder, len(n.library.Folders))
	for i, folder := range n.library.Folders {
		folders[i] = folder
		folders[i].Buffers = append([]Buffer(nil), folder.Buffers...)
	}
	return Library{
		Folders:   folders,
		Active:    n.library.Active,
		DataDir:   root,
		ImagesDir: filepath.Join(root, ImagesDirName),
	}, nil
}

// Load returns the text of a buffer.
func (n *Notes) Load(id string) (string, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	dir, err := NotesDir()
	if err != nil {
		return "", err
	}
	body, err := os.ReadFile(filepath.Join(dir, id+".txt"))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// Position reads where the caret stood in a note the last time it was written,
// as an offset into its text.
func (n *Notes) Position(id string) (int, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return 0, err
	}
	return n.library.Positions[id], nil
}

// The notes are bound to the page, so every method here is a call the page can
// make. The write hook is therefore a package function: the page has no way to
// reach it.
var (
	hookMu    sync.Mutex
	afterSave func()
)

// OnSave registers fn, called after a note's text is on disk, or nil to
// unregister it. The app waits for it before it quits: the page writes when the
// panel hides, and a quit that outran that write would drop the last keystrokes.
func OnSave(fn func()) {
	hookMu.Lock()
	defer hookMu.Unlock()
	afterSave = fn
}

// Save writes a buffer's text and title, and where the caret stood when it was
// written, so that opening the note again puts the user back where they left
// it.
func (n *Notes) Save(id, title, text string, at int) error {
	if err := n.save(id, title, text, at); err != nil {
		return err
	}
	hookMu.Lock()
	after := afterSave
	hookMu.Unlock()
	if after != nil {
		after()
	}
	return nil
}

func (n *Notes) save(id, title, text string, at int) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return err
	}
	dir, err := NotesDir()
	if err != nil {
		return err
	}
	if err := WriteFileAtomic(filepath.Join(dir, id+".txt"), []byte(text)); err != nil {
		return err
	}
	fi, bi, ok := n.locate(id)
	if !ok {
		return fmt.Errorf("unknown buffer %q", id)
	}
	changed := n.setPosition(id, min(at, len(text)))
	if n.library.Folders[fi].Buffers[bi].Title != title {
		n.library.Folders[fi].Buffers[bi].Title = title
		changed = true
	}
	if !changed {
		return nil
	}
	return n.saveLibrary()
}

// setPosition keeps where the caret stood in the note, and reports whether the
// library holds something else now.
func (n *Notes) setPosition(id string, at int) bool {
	if n.library.Positions[id] == at {
		return false
	}
	if at <= 0 {
		delete(n.library.Positions, id)
		return true
	}
	if n.library.Positions == nil {
		n.library.Positions = make(map[string]int, 1)
	}
	n.library.Positions[id] = at
	return true
}

// Create adds a note to a folder and returns it. An empty folderID puts it in
// the first folder.
func (n *Notes) Create(folderID, title string) (Buffer, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return Buffer{}, err
	}
	fi := 0
	if folderID != "" {
		fi = n.folderIndex(folderID)
		if fi < 0 {
			return Buffer{}, fmt.Errorf("unknown folder %q", folderID)
		}
	}
	buffer, err := n.create(title)
	if err != nil {
		return Buffer{}, err
	}
	n.library.Folders[fi].Buffers = append(n.library.Folders[fi].Buffers, buffer)
	n.library.Active = buffer.ID
	if err := n.saveLibrary(); err != nil {
		return Buffer{}, err
	}
	return buffer, nil
}

func (n *Notes) create(title string) (Buffer, error) {
	dir, err := NotesDir()
	if err != nil {
		return Buffer{}, err
	}
	id := newID()
	if err := WriteFileAtomic(filepath.Join(dir, id+".txt"), nil); err != nil {
		return Buffer{}, err
	}
	return Buffer{ID: id, Title: title}, nil
}

// CreateFolder adds a folder with one empty note in it, and returns it.
func (n *Notes) CreateFolder(title string) (Folder, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return Folder{}, err
	}
	folder, buffer, err := n.createFolder(title)
	if err != nil {
		return Folder{}, err
	}
	folder.Buffers = []Buffer{buffer}
	n.library.Folders = append(n.library.Folders, folder)
	n.library.Active = buffer.ID
	if err := n.saveLibrary(); err != nil {
		return Folder{}, err
	}
	return folder, nil
}

func (n *Notes) createFolder(title string) (Folder, Buffer, error) {
	buffer, err := n.create(newNoteTitle)
	if err != nil {
		return Folder{}, Buffer{}, err
	}
	return Folder{ID: newID(), Title: title, Buffers: nil}, buffer, nil
}

// RenameFolder retitles a folder.
func (n *Notes) RenameFolder(id, title string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return err
	}
	fi := n.folderIndex(id)
	if fi < 0 {
		return fmt.Errorf("unknown folder %q", id)
	}
	if n.library.Folders[fi].Title == title {
		return nil
	}
	n.library.Folders[fi].Title = title
	return n.saveLibrary()
}

// ReorderFolders puts the folders in the order of ids, which names every one of
// them.
func (n *Notes) ReorderFolders(ids []string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return err
	}
	if len(ids) != len(n.library.Folders) {
		return errors.New("the order does not name every folder")
	}
	ordered := make([]Folder, 0, len(ids))
	for _, id := range ids {
		fi := n.folderIndex(id)
		if fi < 0 {
			return fmt.Errorf("unknown folder %q", id)
		}
		ordered = append(ordered, n.library.Folders[fi])
		n.library.Folders = slices.Delete(n.library.Folders, fi, fi+1)
	}
	n.library.Folders = ordered
	return n.saveLibrary()
}

// MoveNote puts a note at index of a folder's notes. The index is the place the
// note takes among the notes as the caller sees them, before the move.
func (n *Notes) MoveNote(id, folderID string, index int) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return err
	}
	fi, bi, ok := n.locate(id)
	if !ok {
		return fmt.Errorf("unknown buffer %q", id)
	}
	ti := n.folderIndex(folderID)
	if ti < 0 {
		return fmt.Errorf("unknown folder %q", folderID)
	}
	buffer := n.library.Folders[fi].Buffers[bi]
	n.library.Folders[fi].Buffers = slices.Delete(n.library.Folders[fi].Buffers, bi, bi+1)
	if fi == ti && index > bi {
		// The note no longer sits where the caller counted from.
		index--
	}
	target := n.library.Folders[ti].Buffers
	index = max(0, min(index, len(target)))
	target = slices.Insert(target, index, buffer)
	n.library.Folders[ti].Buffers = target
	return n.saveLibrary()
}

// SetPinned shows or hides a note in the sidebar's Pinned section.
func (n *Notes) SetPinned(id string, pinned bool) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return err
	}
	fi, bi, ok := n.locate(id)
	if !ok {
		return fmt.Errorf("unknown buffer %q", id)
	}
	if n.library.Folders[fi].Buffers[bi].Pinned == pinned {
		return nil
	}
	n.library.Folders[fi].Buffers[bi].Pinned = pinned
	return n.saveLibrary()
}

// Remove deletes a note's file and forgets it. Pictures it referred to are left
// to the sweep, which waits before trashing anything, so that an undo of the
// deletion would still find them.
func (n *Notes) Remove(id string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return err
	}
	fi, bi, ok := n.locate(id)
	if !ok {
		return fmt.Errorf("unknown buffer %q", id)
	}
	folder := &n.library.Folders[fi]
	folder.Buffers = slices.Delete(folder.Buffers, bi, bi+1)
	if n.library.Active == id {
		if len(folder.Buffers) > 0 {
			n.library.Active = folder.Buffers[max(0, bi-1)].ID
		} else {
			n.library.Active = n.firstNote()
		}
	}
	if err := n.ensureNote(); err != nil {
		return err
	}
	dir, err := NotesDir()
	if err != nil {
		return err
	}
	if err := mygo.Shell.TrashItem(filepath.Join(dir, id+".txt")); err != nil {
		log.Printf("trashing the note %s: %v", id, err)
	}
	delete(n.library.Positions, id)
	return n.saveLibrary()
}

// RemoveFolder asks, then trashes a folder's notes and forgets it. The last
// folder stays: the sidebar always has somewhere to put a note.
func (n *Notes) RemoveFolder(ctx context.Context, id string) error {
	n.mu.Lock()
	err := n.loadLibrary()
	if err != nil {
		n.mu.Unlock()
		return err
	}
	if len(n.library.Folders) <= 1 {
		n.mu.Unlock()
		return errors.New("the last folder stays")
	}
	fi := n.folderIndex(id)
	if fi < 0 {
		n.mu.Unlock()
		return fmt.Errorf("unknown folder %q", id)
	}
	title, count := n.library.Folders[fi].Title, len(n.library.Folders[fi].Buffers)
	n.mu.Unlock()

	// The dialog runs without the lock: the page keeps drawing while the user
	// decides, and a note saved meanwhile is not held up.
	what := fmt.Sprintf("%d notes", count)
	if count == 1 {
		what = "The note"
	}
	answer, err := mygo.Dialog.Message(mygo.MessageOptions{
		Parent:        mygo.CallerWindow(ctx),
		Type:          mygo.MessageWarning,
		Title:         "Delete " + title + "?",
		Message:       what + " and the folder go to the Trash.",
		Buttons:       []string{"Delete", "Cancel"},
		DefaultButton: 0,
		CancelButton:  1,
	})
	if err != nil {
		return err
	}
	if answer.Button != 0 {
		return nil
	}

	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return err
	}
	fi = n.folderIndex(id)
	if fi < 0 {
		return fmt.Errorf("unknown folder %q", id)
	}
	dir, err := NotesDir()
	if err != nil {
		return err
	}
	for _, buffer := range n.library.Folders[fi].Buffers {
		if err := mygo.Shell.TrashItem(filepath.Join(dir, buffer.ID+".txt")); err != nil {
			log.Printf("trashing the note %s: %v", buffer.ID, err)
		}
		delete(n.library.Positions, buffer.ID)
	}
	n.library.Folders = slices.Delete(n.library.Folders, fi, fi+1)
	if _, _, ok := n.locate(n.library.Active); !ok {
		n.library.Active = n.firstNote()
	}
	if err := n.ensureNote(); err != nil {
		return err
	}
	return n.saveLibrary()
}

// Activate remembers which note was open, so that the app opens it again.
func (n *Notes) Activate(id string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return err
	}
	n.library.Active = id
	return n.saveLibrary()
}

func newID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
