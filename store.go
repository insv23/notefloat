package main

import (
	"context"
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
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// Everything the app keeps lives in one directory of the user's:
//
//	<userData>/notes/<buffer>.txt   one plain text file per note
//	<userData>/images/<sha256>.<ext>   pasted pictures, flat, named by content
//	<userData>/library.json        the folders, their notes and which one was open
//
// The notes are files of one flat directory whatever folder they show in:
// folders are an arrangement in library.json, so moving a note between them
// never moves a file, and a note file stays readable on its own.
const (
	notesDirName  = "notes"
	imagesDirName = "images"
	libraryFile   = "library.json"
	imageScheme   = "notefloat-img"
)

// defaultFolderTitle names the folder the notes of an install without folders
// end up in.
const defaultFolderTitle = "Notes"

// newNoteTitle titles a note the user did not name yet.
const newNoteTitle = "Untitled"

// appRoot returns the app's data directory, creating the directories the app
// writes to. It is read on every call rather than kept: Preferences may point
// the app at another directory while it runs.
func appRoot() (string, error) {
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
}

// defaultAppRoot is the data directory the app uses until the user picks
// another one.
func defaultAppRoot() (string, error) {
	appData, err := mygo.App.Path(mygo.PathAppData)
	if err != nil {
		return "", err
	}
	return filepath.Join(appData, mygo.App.Name()), nil
}

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
	// Buffers is the layout of an install from before folders: one flat list
	// of notes. It is moved into Folders on the first read.
	Buffers []Buffer `json:"buffers,omitempty"`
}

// Notes is the store the page calls. Every write is atomic: the file is
// written beside its destination and renamed, so a crash never leaves a half
// written note.
type Notes struct {
	mu      sync.Mutex
	library libraryFileContent
	loaded  bool
}

// reset forgets the library read from disk, so that the next call reads it
// from whichever directory the app points at then.
func (n *Notes) reset() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.library = libraryFileContent{}
	n.loaded = false
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
	return n.saveLibrary()
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
	root, err := appRoot()
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
		ImagesDir: filepath.Join(root, imagesDirName),
	}, nil
}

// absImageRef matches a line holding a whole path under an images directory,
// the way notes written before pictures were kept relative name them. The path
// may hold spaces, so only the line ends bound it.
var absImageRef = regexp.MustCompile(`(?m)^/[^\n]*/images/([0-9a-f]{64}\.(?:png|jpg|gif|webp|heic))[ \t]*$`)

// relativeNote rewrites whole picture paths into the relative form a note
// keeps, so that the file stays valid wherever the notes are moved to.
func relativeNote(text string) string {
	return absImageRef.ReplaceAllString(text, imagesDirName+"/$1")
}

// Load returns the text of a buffer.
func (n *Notes) Load(id string) (string, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	dir, err := notesDir()
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, id+".txt")
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	text := string(body)
	if fixed := relativeNote(text); fixed != text {
		// A note written before pictures were kept relative: the file is
		// carried to the current form the first time it is opened.
		if err := writeFileAtomic(path, []byte(fixed)); err != nil {
			log.Printf("rewriting the picture paths of %s: %v", id, err)
		}
		text = fixed
	}
	return text, nil
}

// searchLimit caps what one search hands back. The sidebar lists the matches
// while the user is still typing, so a word every note holds cannot be allowed
// to carry the whole library across in one go.
const searchLimit = 200

// The note file's shapes, as the search reads them: the editor shows a todo
// without its checkbox, and a picture is not text at all. Both are left out, so
// that a match is a piece of what the user sees and its offset names a place in
// the line the editor holds.
var (
	todoPrefix     = regexp.MustCompile(`^\s*- \[[ xX]\] ?(.*)$`)
	pictureLine    = regexp.MustCompile(`^(?:images/|/).*\.(?:png|jpe?g|gif|webp|heic)\s*$`)
	blockSeparator = regexp.MustCompile(`^∞∞∞\S*$`)
)

// SearchHit is one line of a note that matches a search: the note it belongs
// to, which line of the note's file matched, where in the visible text the
// match starts, and the lines around it, for the result list to show the
// match in its place. Offset counts in UTF-16 code units, the index a
// JavaScript string slices by, so that the page can cut the line at the match
// with it; a Go byte offset would land elsewhere as soon as the line holds a
// character that is not ASCII.
type SearchHit struct {
	Note   string `json:"note"`
	Title  string `json:"title"`
	Line   int    `json:"line"`
	Offset int    `json:"offset"`
	Text   string `json:"text"`
	Before string `json:"before"`
	After  string `json:"after"`
}

// visibleText is a line of a note as the editor shows it.
func visibleText(line string) (string, bool) {
	if blockSeparator.MatchString(line) || pictureLine.MatchString(strings.TrimSpace(line)) {
		return "", false
	}
	if todo := todoPrefix.FindStringSubmatch(line); todo != nil {
		return todo[1], true
	}
	return line, true
}

// utf16Index is how many UTF-16 code units stand in text before byte at: a
// rune past the Basic Multilingual Plane takes two there.
func utf16Index(text string, at int) int {
	units := 0
	for _, r := range text[:at] {
		units++
		if r > 0xFFFF {
			units++
		}
	}
	return units
}

// contextLine is a line beside a match, as the result list shows it: a picture
// and a block separator are no context to read, and neither is a line beyond
// the note's ends.
func contextLine(lines []string, at int) string {
	if at < 0 || at >= len(lines) {
		return ""
	}
	text, ok := visibleText(lines[at])
	if !ok {
		return ""
	}
	return text
}

// Search returns the lines of every note that hold query, the notes in the
// order the sidebar shows them, and the lines in the order they are written.
// Case folds unless the user asked for a match that does not.
func (n *Notes) Search(query string, caseSensitive bool) ([]SearchHit, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.loadLibrary(); err != nil {
		return nil, err
	}
	hits := []SearchHit{}
	if query == "" {
		return hits, nil
	}
	dir, err := notesDir()
	if err != nil {
		return nil, err
	}
	needle := query
	if !caseSensitive {
		needle = strings.ToLower(needle)
	}
	for _, folder := range n.library.Folders {
		for _, buffer := range folder.Buffers {
			body, err := os.ReadFile(filepath.Join(dir, buffer.ID+".txt"))
			if err != nil {
				// A note whose file is gone has nothing to find.
				continue
			}
			lines := strings.Split(string(body), "\n")
			for number, line := range lines {
				text, ok := visibleText(line)
				if !ok {
					continue
				}
				hay := text
				if !caseSensitive {
					hay = strings.ToLower(hay)
				}
				at := strings.Index(hay, needle)
				if at < 0 {
					continue
				}
				hits = append(hits, SearchHit{
					Note:   buffer.ID,
					Title:  buffer.Title,
					Line:   number,
					Offset: utf16Index(text, at),
					Text:   text,
					Before: contextLine(lines, number-1),
					After:  contextLine(lines, number+1),
				})
				if len(hits) >= searchLimit {
					return hits, nil
				}
			}
		}
	}
	return hits, nil
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
	if err := writeFileAtomic(filepath.Join(dir, id+".txt"), []byte(relativeNote(text))); err != nil {
		return err
	}
	fi, bi, ok := n.locate(id)
	if !ok {
		return fmt.Errorf("unknown buffer %q", id)
	}
	if n.library.Folders[fi].Buffers[bi].Title == title {
		return nil
	}
	n.library.Folders[fi].Buffers[bi].Title = title
	return n.saveLibrary()
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

// ReorderFolders puts the folders in the order of ids, which names every one
// of them.
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

// MoveNote puts a note at index of a folder's notes. The index is the place
// the note takes among the notes as the caller sees them, before the move.
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

// Remove deletes a note's file and forgets it. Pictures it referred to are
// left to the sweep, which waits before trashing anything, so that an undo of
// the deletion would still find them.
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
	dir, err := notesDir()
	if err != nil {
		return err
	}
	if err := mygo.Shell.TrashItem(filepath.Join(dir, id+".txt")); err != nil {
		log.Printf("trashing the note %s: %v", id, err)
	}
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
	dir, err := notesDir()
	if err != nil {
		return err
	}
	for _, buffer := range n.library.Folders[fi].Buffers {
		if err := mygo.Shell.TrashItem(filepath.Join(dir, buffer.ID+".txt")); err != nil {
			log.Printf("trashing the note %s: %v", buffer.ID, err)
		}
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

// Images stores the pictures pasted into a note.
type Images struct {
	mu sync.Mutex
}

// Save writes a pasted picture and returns its path relative to the data
// directory, images/<sha>.<ext>, which the note then holds as plain text: the
// note keeps finding its pictures after the whole directory moves. The pasted
// bytes name the file, so pasting one picture twice stores it once.
// The name is the SHA-256 of the bytes, so pasting the same picture twice
// reuses one file, and a note dropping its reference cannot pull a file
// another note still points at.
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
	dir := root
	path := filepath.Join(dir, name)
	rel := filepath.ToSlash(filepath.Join(imagesDirName, name))
	if _, statErr := os.Stat(path); statErr == nil {
		// The picture is already stored: keep its clock running so that the
		// sweep does not trash it soon after this paste.
		now := time.Now()
		_ = os.Chtimes(path, now, now)
		return rel, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := writeFileAtomic(path, raw); err != nil {
		return "", err
	}
	return rel, nil
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
