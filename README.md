# Pagecraft

A client-only JavaScript SPA for organizing PDF pages. No build, backend, account, or external runtime requests. PDF files stay in browser memory.

## Run

Serve this directory with any static HTTP server. With Python installed:

```sh
python -m http.server 8080
```

On Windows, use `py -m http.server 8080`. Open http://localhost:8080. ES modules and PDF workers require HTTP; opening `index.html` directly via `file://` is unsupported. Deploy the folder to any static web host to share the app.

## Features

- Open or drop a PDF up to 100 MB, or try the built-in four-page sample.
- Lazy-rendered page previews.
- Use **Add PDF** to append one or more PDF documents (up to 100 MB per batch), or drop PDFs onto an open document. Pages retain their original sizes and can be freely mixed with existing PDF and JPG pages. An invalid batch adds no pages. **Open another** still starts a new editing session.
- Add one or more `.jpg` / `.jpeg` files using **Add JPG pages**, or drop them onto an open document. Each image is appended as a separate page and supports the same reorder, remove, and undo controls.
- Reorder by dragging or with accessible earlier/later buttons (also work on touchscreens).
- Remove individual pages or a selected group.
- Undo up to 100 edits with the button or Ctrl/Cmd+Z; reset to the original order.
- Download the remaining pages in their displayed order as `original-name-edited.pdf`.
- Responsive layout, keyboard controls, live status messages, reduced-motion support.

The original file is never changed. Opening another document replaces the current editing session; download first to keep changes. Reloading the page clears the session. At least one page is required to download.

Undo reverses a PDF import as one edit. Reset removes all appended PDF and JPG pages and restores the initial document. Added PDF pages also serve as width references for neighbouring JPG pages.

JPG imports keep their aspect ratio and camera orientation, with no cropping or margins. On download, each image matches the visible width of the nearest PDF page in the current arrangement (preferring the preceding page when equally close). Height scales proportionally. This accounts for PDF page rotation and cropping, and updates after reordering or removal. If only JPG pages remain, they use the original PDF's first page width. Images are normalized to lossless PNG internally, so exported file size may increase. Each import batch supports up to 100 MB of JPGs, with a 25-megapixel limit per image. A failed batch leaves the document unchanged. Reset removes added JPG pages and restores the original PDF; undo can restore the previous arrangement, including its images.

## Implementation

Plain HTML, CSS, and JavaScript. Locally bundled [PDF.js](https://mozilla.github.io/pdf.js/) 6.3.289 renders previews, including local fonts, CMaps, and WebAssembly resources. [pdf-lib](https://pdf-lib.js.org/docs/api/classes/pdfdocument) 1.17.1 copies original pages into the output PDF, preserving page content instead of rasterizing it. Dependency licenses are in `vendor/`.

This is a page organizer, not a text or form editor. Password-protected PDFs must be unlocked first. Complex document-level features such as bookmarks, form interactivity, internal destinations, attachments, and digital signatures are not guaranteed to survive a modified export. Unmodified downloads use the original bytes. Large files are limited by available browser memory. Use a current Chrome, Edge, Firefox, or Safari browser.

## Browser checks

Install Python Playwright (`py -m pip install playwright`) and run the static server, then run `py tests/browser_test.py`. The test uses installed Microsoft Edge by default; set `BROWSER_CHANNEL=chromium` after `py -m playwright install chromium` to use bundled Chromium instead.
