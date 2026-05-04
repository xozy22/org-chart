/**
 * Image-cropper modal — Promise-based wrapper around CropperJS.
 *
 *   const blob = await openCropper(file);
 *   if (blob) await uploadToBackend(blob);     // user confirmed crop
 *   if (blob === 'original') uploadOriginal();  // user kept the file as-is
 *   if (blob === null)       cancelled();        // user closed the modal
 *
 * The crop area is locked to a 1:1 aspect ratio because the org-chart
 * card avatars are circular at 40 px — there's no benefit to non-square
 * crops. Output is JPEG @ 0.9 quality, 512×512 max — enough for retina
 * rendering at the avatar size, small enough to keep storage tidy.
 */

import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';

/** Sentinel value for "use the original file unchanged". */
export type CropResult = Blob | 'original' | null;

const MODAL_ID = 'image-crop-modal';
const IMAGE_ID = 'image-crop-target';
const OUTPUT_MAX = 512; // px — final cropped image size

let cropper: Cropper | null = null;
let currentObjectUrl: string | null = null;

function $(sel: string): HTMLElement | null {
  return document.querySelector(sel);
}

function destroyCropper(): void {
  if (cropper) {
    cropper.destroy();
    cropper = null;
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

/**
 * Show the modal, let the user crop, return either the cropped blob,
 * the literal `'original'` (skip cropping), or `null` (cancelled).
 *
 * Re-entrant calls are rejected — only one cropper at a time.
 */
export async function openCropper(file: File): Promise<CropResult> {
  const modal = $('#' + MODAL_ID);
  const img = document.getElementById(IMAGE_ID) as HTMLImageElement | null;
  const okBtn = $('#image-crop-ok');
  const skipBtn = $('#image-crop-skip');
  const cancelBtn = $('#image-crop-cancel');
  const closeBtn = modal?.querySelector('[data-close]') as HTMLElement | null;
  const backdrop = modal?.querySelector('.modal-backdrop') as HTMLElement | null;

  if (!modal || !img || !okBtn || !skipBtn || !cancelBtn) {
    console.warn('image-crop-modal markup missing — falling back to "use original"');
    return 'original';
  }

  // SVGs aren't usefully crop-able with a raster cropper (we'd lose
  // vector-ness on `getCroppedCanvas`), so just return the file as-is.
  if (file.type === 'image/svg+xml') return 'original';

  return new Promise<CropResult>((resolve) => {
    let resolved = false;
    function settle(value: CropResult): void {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    }

    function cleanup(): void {
      modal!.hidden = true;
      destroyCropper();
      okBtn!.removeEventListener('click', onOk);
      skipBtn!.removeEventListener('click', onSkip);
      cancelBtn!.removeEventListener('click', onCancel);
      closeBtn?.removeEventListener('click', onCancel);
      backdrop?.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
    }

    function onOk(): void {
      if (!cropper) return settle('original');
      const canvas = cropper.getCroppedCanvas({
        width: OUTPUT_MAX,
        height: OUTPUT_MAX,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high',
        fillColor: '#ffffff',
      });
      if (!canvas) return settle(null);
      canvas.toBlob(
        (blob) => settle(blob ?? null),
        'image/jpeg',
        0.9,
      );
    }
    function onSkip(): void {
      settle('original');
    }
    function onCancel(): void {
      settle(null);
    }
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') onCancel();
    }

    okBtn!.addEventListener('click', onOk);
    skipBtn!.addEventListener('click', onSkip);
    cancelBtn!.addEventListener('click', onCancel);
    closeBtn?.addEventListener('click', onCancel);
    backdrop?.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);

    // Set image source then wait for it to load so CropperJS knows the
    // natural dimensions before initialising.
    currentObjectUrl = URL.createObjectURL(file);
    img!.onload = () => {
      // Defer a tick so the DOM has the new image height before init.
      requestAnimationFrame(() => {
        try {
          cropper = new Cropper(img!, {
            aspectRatio: 1,
            viewMode: 1, // crop box restricted to canvas
            autoCropArea: 0.9,
            background: false,
            zoomable: true,
            scalable: false,
            rotatable: false,
            movable: true,
            responsive: true,
            checkOrientation: true, // honour EXIF rotation (phone photos)
            minCropBoxWidth: 50,
            minCropBoxHeight: 50,
          });
        } catch (err) {
          console.error('Cropper init failed:', err);
          settle('original');
        }
      });
    };
    img!.onerror = () => {
      settle(null);
    };
    img!.src = currentObjectUrl;
    modal!.hidden = false;
  });
}
