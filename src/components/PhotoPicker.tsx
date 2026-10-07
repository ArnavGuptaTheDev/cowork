import { useRef, useState } from 'preact/hooks';
import { upload, errorMessage } from '../lib/api';
import { compressImage } from '../lib/image';
import type { Photo } from '../lib/types';
import { Icon, toast } from './ui';

let pickerSeq = 0;

/** Two inputs: camera capture (opens the camera on phones) and a regular library/file picker. */
export function PhotoButtons({ onFiles, disabled, compact }: { onFiles: (files: File[]) => void; disabled?: boolean; compact?: boolean }) {
  const id = useRef(`pp-${++pickerSeq}`).current;
  const handle = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) onFiles(files);
  };
  return (
    <div class="photo-add">
      <label for={`${id}-cam`}>
        <input id={`${id}-cam`} type="file" accept="image/*" capture="environment" onChange={handle} disabled={disabled} />
        <span class={`btn ghost ${compact ? 'quiet' : ''}`}>
          <Icon name="camera" /> Take photo
        </span>
      </label>
      <label for={`${id}-file`}>
        <input id={`${id}-file`} type="file" accept="image/*" multiple onChange={handle} disabled={disabled} />
        <span class={`btn ghost ${compact ? 'quiet' : ''}`}>
          <Icon name="image" /> Upload
        </span>
      </label>
    </div>
  );
}

/** Compresses then uploads photos to a todo, a completion (instance) or a suggestion. */
export async function uploadPhotos(files: File[], target: { todoId?: string; instanceId?: string; suggestionId?: string }): Promise<Photo[]> {
  const out: Photo[] = [];
  for (const f of files) {
    try {
      const { blob, width, height } = await compressImage(f);
      const form = new FormData();
      form.set('file', new File([blob], blob.type === 'image/webp' ? 'photo.webp' : 'photo.jpg', { type: blob.type }));
      form.set('width', String(width));
      form.set('height', String(height));
      for (const [k, v] of Object.entries(target)) if (v) form.set(k, v);
      const { photo } = await upload<{ photo: Photo }>('/api/photos', form);
      out.push(photo);
    } catch (e) {
      toast(`Couldn't add a photo: ${errorMessage(e)}`, 'error');
    }
  }
  return out;
}

export function PhotoGrid({ photos, onDelete }: { photos: Photo[]; onDelete?: (p: Photo) => void }) {
  const [open, setOpen] = useState<Photo | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const show = (p: Photo) => {
    setOpen(p);
    requestAnimationFrame(() => ref.current?.showModal());
  };
  if (!photos.length) return null;
  return (
    <>
      <div class="photo-grid">
        {photos.map((p) => (
          <figure key={p.id}>
            <button type="button" class="open" onClick={() => show(p)} aria-label="View photo">
              <img src={p.url} alt="" loading="lazy" width={p.width ?? undefined} height={p.height ?? undefined} />
            </button>
            {onDelete && (
              <button type="button" class="del" onClick={() => onDelete(p)} aria-label="Delete photo">
                <Icon name="x" />
              </button>
            )}
          </figure>
        ))}
      </div>
      <dialog ref={ref} class="lightbox" onClick={() => ref.current?.close()} onClose={() => setOpen(null)} aria-label="Photo">
        {open && <img src={open.url} alt="" />}
      </dialog>
    </>
  );
}
