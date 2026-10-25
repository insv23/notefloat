package pictures

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"notefloat/internal/store"
)

// imageScheme is what the page asks a picture by: the part after images/ is the
// file's name, which is all that survives the notes being moved elsewhere.
const Scheme = "notefloat-img"

// Images stores the pictures pasted into a note.
type Images struct {
	mu sync.Mutex
}

// Save writes a pasted picture and returns its path relative to the data
// directory, images/<sha>.<ext>, which the note then holds as plain text: the
// note keeps finding its pictures after the whole directory moves. The pasted
// bytes name the file, so pasting one picture twice stores it once, and a note
// dropping its reference cannot pull a file another note still points at.
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
	root, err := store.ImagesDir()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	name := hex.EncodeToString(sum[:]) + imageExt(raw)
	path := filepath.Join(root, name)
	rel := filepath.ToSlash(filepath.Join(store.ImagesDirName, name))
	if _, statErr := os.Stat(path); statErr == nil {
		// The picture is already stored: keep its clock running so that the
		// sweep does not trash it soon after this paste.
		now := time.Now()
		_ = os.Chtimes(path, now, now)
		return rel, nil
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", err
	}
	if err := store.WriteFileAtomic(path, raw); err != nil {
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

// Serve lets the page show a picture by its name under images/.
func Serve() {
	dir, err := store.ImagesDir()
	if err != nil {
		log.Printf("serving the pictures: %v", err)
		return
	}
	if err := mygo.Protocol.Handle(Scheme, mygo.FileServer(os.DirFS(dir))); err != nil {
		log.Printf("serving the pictures: %v", err)
	}
}
