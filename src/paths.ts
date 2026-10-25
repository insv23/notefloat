// One rule for the pictures a note holds. A note keeps images/<name>, the page
// asks for one through the scheme, and what leaves the app in a copy is the
// whole path. Every module that names a picture goes through these three.
import { IMAGE_DIR } from "./editor/model";

export const IMAGE_SCHEME = "notefloat-img";

/** pictureName is the file under images/ that a path names, whether it is the
 * relative form a note keeps or the whole one an older note holds. */
function pictureName(path: string): string | null {
  const at = path.lastIndexOf(`/${IMAGE_DIR}`);
  const bare = at >= 0 ? path.slice(at + IMAGE_DIR.length) : path.startsWith(IMAGE_DIR) ? path.slice(IMAGE_DIR.length) : "";
  return bare === "" ? null : bare;
}

/** relative is the form a note keeps: images/<name>, or the path unchanged
 * when it names no picture. */
export function relative(path: string): string {
  const name = pictureName(path);
  return name === null ? path : IMAGE_DIR + name;
}

/** absolute names a picture where it is on disk, for text that leaves the app:
 * what the user pastes elsewhere is a whole path anything can open. */
export function absolute(path: string, imagesDir: string): string {
  const name = pictureName(path);
  return name === null ? path : `${imagesDir}/${name}`;
}

/** imageURL is what the page loads a picture from, whatever form the note
 * holds: the scheme serves the part after images/. */
export function imageURL(path: string): string {
  const name = pictureName(path);
  return name === null ? "" : `${IMAGE_SCHEME}://localhost/${name}`;
}
