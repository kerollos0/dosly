import { ApiError } from '@/lib/api';

/**
 * Multipart upload with progress. fetch() cannot report upload progress, and agencies send
 * documents up to 100 MB on slow connections, so this uses XMLHttpRequest.
 */
export function uploadWithProgress<T>(path: string, form: FormData, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = true;
    xhr.responseType = 'json';
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      const data = (xhr.response ?? {}) as { message?: string; error?: string };
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, data.message ?? (xhr.status === 413 ? 'الملف كبير جدًا' : 'الرفع ماكملش. جرّب تاني.'), data.error ?? 'error'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'النت فصل أثناء الرفع. جرّب تاني.', 'network'));
    xhr.onabort = () => reject(new ApiError(0, 'اتلغى', 'aborted'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(form);
  });
}

export const MAX_UPLOAD = 100 * 1024 * 1024;
export const ACCEPT = 'image/*,video/mp4,video/3gpp,video/quicktime,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt';
