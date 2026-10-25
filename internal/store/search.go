package store

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// searchLimit caps what one search hands back. The dialog lists the matches
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

// SearchHit is one line of a note that matches a search: the note it belongs to,
// which line of the note's file matched, where in the visible text the match
// starts, and the lines around it, for the result list to show the match in its
// place. Offset counts in UTF-16 code units, the index a JavaScript string
// slices by, so that the page can cut the line at the match with it; a Go byte
// offset would land elsewhere as soon as the line holds a character that is not
// ASCII.
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

// utf16Index is how many UTF-16 code units stand in text before byte at: a rune
// past the Basic Multilingual Plane takes two there.
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
	dir, err := NotesDir()
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
