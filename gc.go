package main

import (
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/egoist/mygo"
)

// imageGrace is how long a picture stays after the notes stopped referring to
// it. A picture is not deleted the moment its path leaves a note: the deletion
// of a line can be undone, the path may have been copied into another app, and
// the notes are edited and written by different processes. Days, not minutes,
// make those cases safe.
const imageGrace = 7 * 24 * time.Hour

// imageRef matches the paths Images.Save writes into a note, relative to the
// app's data directory.
var imageRef = regexp.MustCompile(`images/[0-9]{4}-[0-9]{2}/[0-9a-f]{64}\.(?:png|jpg|gif|webp|heic)`)

// sweepImages moves the pictures no note refers to and that have not been
// referred to for grace to the trash. The modification time of a picture is
// the clock: a referenced picture has it moved forward on every sweep, so an
// unreferenced one ages from the moment its last note stopped pointing at it,
// not from when it was pasted.
func sweepImages(grace time.Duration) error {
	root, err := appRoot()
	if err != nil {
		return err
	}
	notes, err := notesDir()
	if err != nil {
		return err
	}
	images, err := imagesDir()
	if err != nil {
		return err
	}

	referenced := map[string]bool{}
	entries, err := os.ReadDir(notes)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".txt" {
			continue
		}
		body, err := os.ReadFile(filepath.Join(notes, entry.Name()))
		if err != nil {
			continue
		}
		for _, match := range imageRef.FindAllString(string(body), -1) {
			referenced[match] = true
		}
	}

	now := time.Now()
	cutoff := now.Add(-grace)
	return filepath.WalkDir(images, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		if referenced[filepath.ToSlash(rel)] {
			// Keep the clock of a live picture running; a failure here only
			// means the picture ages, which the next sweep corrects.
			_ = os.Chtimes(path, now, now)
			return nil
		}
		info, err := entry.Info()
		if err != nil || info.ModTime().After(cutoff) {
			return nil
		}
		if err := mygo.Shell.TrashItem(path); err != nil {
			log.Printf("trashing the unused picture %s: %v", path, err)
			return nil
		}
		log.Printf("moved an unused picture to the trash: %s", path)
		return nil
	})
}

// startImageSweep runs the sweep once shortly after the app starts, and then
// once a day. It is a plain goroutine: no launch agent, no timer that keeps the
// app awake, and nothing to lose if the app is not running that day.
func startImageSweep() {
	go func() {
		time.Sleep(30 * time.Second)
		for {
			if err := sweepImages(imageGrace); err != nil {
				log.Printf("sweeping unused pictures: %v", err)
			}
			time.Sleep(24 * time.Hour)
		}
	}()
}
