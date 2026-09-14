"""End-to-end checks against the running static app; no application server needed."""
import os
import struct
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect


def run():
    with sync_playwright() as playwright, tempfile.TemporaryDirectory() as temp:
        browser = playwright.chromium.launch(channel=os.getenv('BROWSER_CHANNEL', 'msedge'), headless=True)
        page = browser.new_page(viewport={"width": 1365, "height": 1000}, accept_downloads=True)
        errors, external_requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: external_requests.append(request.url) if not request.url.startswith(('http://127.0.0.1:8080/', 'blob:', 'data:')) else None)
        page.goto('http://127.0.0.1:8080/')
        expect(page.get_by_role('heading', name='Your PDF, in order.')).to_be_visible()
        page.screenshot(path=str(Path(temp) / 'upload.png'), full_page=True)
        page.get_by_role('button', name='Try a sample PDF').click()
        expect(page.locator('.page-card')).to_have_count(4)
        expect(page.locator('.page-preview canvas')).to_have_count(4, timeout=30000)

        # Generate identifiable vector/text pages, then exercise actual file upload.
        fixture = bytes(page.evaluate('''async () => {
          const doc = await PDFLib.PDFDocument.create();
          for (let i = 1; i <= 4; i++) {
            const page = doc.addPage(i === 2 ? [600, 300] : [300, 450]);
            page.drawText(`Original page ${i}`, { x: 30, y: 200, size: 20 });
          }
          return Array.from(await doc.save());
        }'''))
        page.locator('#file-input').set_input_files({'name': 'test-document.pdf', 'mimeType': 'application/pdf', 'buffer': fixture})
        expect(page.locator('#file-name')).to_have_text('test-document.pdf')
        expect(page.locator('.page-preview canvas')).to_have_count(4, timeout=30000)

        def order():
            return page.locator('.page-card').evaluate_all('(cards) => cards.map(card => Number(card.dataset.id) + 1)')

        page.get_by_role('button', name='Move original page 1 later', exact=True).click()
        assert order() == [2, 1, 3, 4]
        page.locator('[data-id="3"] .page-preview').drag_to(page.locator('[data-id="0"] .page-preview'))
        assert order() == [2, 4, 1, 3], order()
        page.get_by_role('button', name='Remove original page 1', exact=True).click()
        assert order() == [2, 4, 3]

        with page.expect_download() as result:
            page.get_by_role('button', name='Download PDF').click()
        download = result.value
        assert download.suggested_filename == 'test-document-edited.pdf'
        downloaded = Path(download.path()).read_bytes()
        inspected = page.evaluate('''async (bytes) => {
          const pdfjs = await import('./vendor/pdfjs/build/pdf.mjs');
          const task = pdfjs.getDocument({data: new Uint8Array(bytes)});
          const doc = await task.promise;
          const results = [];
          for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const text = await page.getTextContent();
            results.push(text.items.map(item => item.str).join(''));
          }
          await task.destroy();
          return results;
        }''', list(downloaded))
        assert inspected == ['Original page 2', 'Original page 4', 'Original page 3'], inspected

        page.get_by_role('button', name='Undo', exact=True).click()
        assert order() == [2, 4, 1, 3]
        page.get_by_role('button', name='Reset', exact=True).click()
        assert order() == [1, 2, 3, 4]
        page.locator('#select-all').check()
        page.locator('#remove-selected').click()
        expect(page.locator('#empty-pages')).to_be_visible()
        expect(page.locator('#download')).to_be_disabled()
        page.get_by_role('button', name='Restore all pages').click()
        assert order() == [1, 2, 3, 4]
        page.get_by_role('checkbox', name='Select original page 2', exact=True).check()
        page.get_by_role('checkbox', name='Select original page 4', exact=True).check()
        assert page.locator('#select-all').evaluate('(el) => el.indeterminate')
        page.locator('#remove-selected').click()
        assert order() == [1, 3]
        page.locator('#file-name').click()
        page.keyboard.press('Control+z')
        assert order() == [1, 2, 3, 4]

        # Invalid input must leave the current document intact.
        page.locator('#file-input').set_input_files({'name': 'broken.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.7\nbroken'})
        expect(page.locator('#message')).to_contain_text('Could not open this PDF')
        assert order() == [1, 2, 3, 4]
        page.locator('#file-input').set_input_files({'name': 'notes.txt', 'mimeType': 'text/plain', 'buffer': b'hello'})
        expect(page.locator('#message')).to_contain_text('Please choose a PDF')
        with page.expect_download() as original_result:
            page.get_by_role('button', name='Download PDF').click()
        assert Path(original_result.value.path()).read_bytes() == fixture

        # Real JPEG input, including a camera orientation tag (90 degrees clockwise).
        jpg = bytes(page.evaluate('''async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 120; canvas.height = 80;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 60, 80);
          ctx.fillStyle = '#0000ff'; ctx.fillRect(60, 0, 60, 80);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 1));
          return Array.from(new Uint8Array(await blob.arrayBuffer()));
        }'''))
        exif = b'Exif\x00\x00' + b'II' + struct.pack('<HIH', 42, 8, 1) + struct.pack('<HHIHHI', 274, 3, 1, 6, 0, 0)
        rotated_jpg = jpg[:2] + b'\xff\xe1' + struct.pack('>H', len(exif) + 2) + exif + jpg[2:]
        images = [
            {'name': 'landscape.jpg', 'mimeType': 'image/jpeg', 'buffer': jpg},
            {'name': 'camera.JPEG', 'mimeType': 'image/jpeg', 'buffer': rotated_jpg},
        ]
        with page.expect_file_chooser() as chooser:
            page.get_by_role('button', name='Add JPG pages').click()
        chooser.value.set_files(images)
        expect(page.locator('.page-card')).to_have_count(6)
        expect(page.locator('.page-preview canvas')).to_have_count(6)
        assert order() == [1, 2, 3, 4, 5, 6]
        page.get_by_role('button', name='Move JPG landscape.jpg earlier', exact=True).click()
        assert order() == [1, 2, 3, 5, 4, 6]
        page.get_by_role('button', name='Remove JPG camera.JPEG', exact=True).click()
        assert order() == [1, 2, 3, 5, 4]
        page.locator('#undo').click()
        assert order() == [1, 2, 3, 5, 4, 6]
        with page.expect_download() as image_result:
            page.locator('#download').click()
        image_pdf = Path(image_result.value.path()).read_bytes()
        image_pages = page.evaluate('''async (bytes) => {
          const pdfjs = await import('./vendor/pdfjs/build/pdf.mjs');
          const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
          const doc = await task.promise;
          const result = [];
          for (const number of [4, 6]) {
            const page = await doc.getPage(number);
            const viewport = page.getViewport({ scale: 1 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width; canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            await page.render({canvasContext: ctx, viewport}).promise;
            result.push({width: viewport.width, height: viewport.height,
              first: Array.from(ctx.getImageData(10, 10, 1, 1).data),
              last: Array.from(ctx.getImageData(canvas.width - 10, canvas.height - 10, 1, 1).data)});
          }
          await task.destroy();
          return result;
        }''', list(image_pdf))
        assert [(p['width'], p['height']) for p in image_pages] == [(300, 200), (300, 450)], image_pages
        for rendered in image_pages:
            assert rendered['first'][0] > 240 and rendered['first'][2] < 15, rendered
            assert rendered['last'][2] > 240 and rendered['last'][0] < 15, rendered

        def exported_sizes():
            with page.expect_download() as result:
                page.locator('#download').click()
            data = Path(result.value.path()).read_bytes()
            return page.evaluate('''async bytes => {
              const doc = await PDFLib.PDFDocument.load(new Uint8Array(bytes));
              return doc.getPages().map(page => [page.getWidth(), page.getHeight()]);
            }''', list(data))

        # Reordering between differently sized PDF pages recalculates width at export.
        page.get_by_role('button', name='Move JPG landscape.jpg earlier', exact=True).click()
        assert order() == [1, 2, 5, 3, 4, 6]
        assert exported_sizes()[2] == [600, 400]
        page.locator('#undo').click()
        # A leading image uses the following PDF page, with no preceding page required.
        page.locator('[data-id="4"] .page-preview').drag_to(page.locator('[data-id="0"] .page-preview'))
        assert order()[0] == 5
        assert exported_sizes()[0] == [300, 200]
        page.locator('#undo').click()

        before_bad_batch = order()
        page.locator('#image-input').set_input_files([images[0], {'name': 'bad.jpg', 'mimeType': 'image/jpeg', 'buffer': b'bad JPEG'}])
        expect(page.locator('#message')).to_contain_text('Could not add "bad.jpg"')
        assert order() == before_bad_batch
        page.locator('#reset').click()
        assert order() == [1, 2, 3, 4]
        page.locator('#undo').click()
        assert order() == before_bad_batch
        page.locator('#reset').click()

        # File drop appends an image; undo removes that import as one edit.
        page.evaluate('''(bytes) => {
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(new File([new Uint8Array(bytes)], 'dropped.jpg', {type: 'image/jpeg'}));
          document.dispatchEvent(new DragEvent('drop', {bubbles: true, dataTransfer}));
        }''', list(jpg))
        expect(page.locator('.page-card')).to_have_count(5)
        page.locator('#undo').click()
        assert order() == [1, 2, 3, 4]

        # Images can also populate a document after every original page was removed.
        page.locator('#select-all').check()
        page.locator('#remove-selected').click()
        page.locator('#image-input').set_input_files(images[0])
        expect(page.locator('.page-card')).to_have_count(1)
        with page.expect_download() as only_image_result:
            page.locator('#download').click()
        only_image_bytes = Path(only_image_result.value.path()).read_bytes()
        assert page.evaluate('''async bytes => {
          const doc = await PDFLib.PDFDocument.load(new Uint8Array(bytes));
          return doc.getPages().map(page => [page.getWidth(), page.getHeight()]);
        }''', list(only_image_bytes)) == [[300, 200]]
        page.locator('#reset').click()

        # Mobile controls and layout must remain usable without drag support.
        page.set_viewport_size({'width': 390, 'height': 844})
        page.get_by_role('button', name='Move original page 1 later', exact=True).click()
        assert order() == [2, 1, 3, 4]
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        expect(page.locator('#download')).to_be_visible()
        page.screenshot(path=str(Path(temp) / 'mobile.png'), full_page=True)
        page.set_viewport_size({'width': 1365, 'height': 1000})

        # Append multiple PDFs without discarding the existing reordered document.
        additional = page.evaluate('''async () => {
          const result = [];
          for (const [label, sizes] of [['incoming', [[500, 700], [700, 500]]], ['appendix', [[800, 400]]]]) {
            const doc = await PDFLib.PDFDocument.create();
            sizes.forEach((size, index) => doc.addPage(size).drawText(`${label} page ${index + 1}`, {x: 30, y: 200, size: 20}));
            result.push(Array.from(await doc.save()));
          }
          return result;
        }''')
        pdf_inputs = [
            {'name': 'incoming.pdf', 'mimeType': 'application/pdf', 'buffer': bytes(additional[0])},
            {'name': 'appendix.pdf', 'mimeType': 'application/pdf', 'buffer': bytes(additional[1])},
        ]
        previous_order = order()
        with page.expect_file_chooser() as chooser:
            page.get_by_role('button', name='Add PDF', exact=True).click()
        chooser.value.set_files(pdf_inputs)
        expect(page.locator('.page-card')).to_have_count(7)
        expect(page.locator('.page-preview canvas')).to_have_count(7, timeout=30000)
        assert order()[:4] == previous_order
        expect(page.locator('#file-name')).to_have_text('test-document.pdf')
        page.locator('#undo').click()
        assert order() == previous_order
        page.locator('#append-pdf-input').set_input_files(pdf_inputs)
        expect(page.locator('.page-card')).to_have_count(7)
        page.get_by_role('button', name='Move incoming.pdf page 1 earlier', exact=True).click()
        page.get_by_role('button', name='Remove incoming.pdf page 2', exact=True).click()
        page.locator('#image-input').set_input_files(images[0])
        expect(page.locator('.page-card')).to_have_count(7)
        merged_order = order()
        with page.expect_download() as merged_result:
            page.locator('#download').click()
        merged = page.evaluate('''async bytes => {
          const pdfjs = await import('./vendor/pdfjs/build/pdf.mjs');
          const task = pdfjs.getDocument({data: new Uint8Array(bytes)});
          const doc = await task.promise;
          const result = [];
          for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const text = await page.getTextContent();
            const view = page.getViewport({scale: 1});
            result.push({text: text.items.map(item => item.str).join(''), width: view.width, height: view.height});
          }
          await task.destroy();
          return result;
        }''', list(Path(merged_result.value.path()).read_bytes()))
        assert [p['text'] for p in merged] == ['Original page 2', 'Original page 1', 'Original page 3', 'incoming page 1', 'Original page 4', 'appendix page 1', ''], merged
        assert (merged[3]['width'], merged[3]['height']) == (500, 700)
        assert (merged[5]['width'], merged[5]['height']) == (800, 400)
        assert merged[6]['width'] == 800 and abs(merged[6]['height'] - 800 * 80 / 120) < .001
        page.locator('#append-pdf-input').set_input_files([pdf_inputs[0], {'name': 'broken.pdf', 'mimeType': 'application/pdf', 'buffer': b'broken'}])
        expect(page.locator('#message')).to_contain_text('Could not add "broken.pdf"')
        assert order() == merged_order
        page.locator('#reset').click()
        assert order() == [1, 2, 3, 4]
        page.locator('#undo').click()
        assert order() == merged_order
        page.evaluate('''bytes => {
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(new File([new Uint8Array(bytes)], 'dropped.pdf', {type: 'application/pdf'}));
          document.dispatchEvent(new DragEvent('drop', {bubbles: true, dataTransfer}));
        }''', additional[1])
        expect(page.locator('.page-card')).to_have_count(8)
        page.locator('#undo').click()
        assert order() == merged_order
        page.set_viewport_size({'width': 390, 'height': 844})
        expect(page.locator('#add-pdf')).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        # Starting another session releases appended documents and clears their pages.
        page.locator('#file-input').set_input_files(pdf_inputs[1])
        expect(page.locator('#file-name')).to_have_text('appendix.pdf')
        expect(page.locator('.page-card')).to_have_count(1)
        expect(page.locator('.page-preview canvas')).to_have_count(1, timeout=30000)
        expect(page.locator('#undo')).to_be_disabled()
        page.set_viewport_size({'width': 1365, 'height': 1000})
        page.screenshot(path=str(Path(__file__).parent / 'editor-check.png'), full_page=True)
        assert not errors, errors
        assert not external_requests, external_requests
        browser.close()
        print('PASS: PDF upload/append/batch/drop, merged PDF text and sizes, neighbouring JPG width, JPG import/orientation/pixels, atomic invalid batches, reorder/remove/undo/reset, session replacement, mobile layout, and no external requests.')


if __name__ == '__main__':
    run()
