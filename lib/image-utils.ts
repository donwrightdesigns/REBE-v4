import { set, get, del } from 'idb-keyval';

export async function compressImage(file: File, maxWidth = 800, maxHeight = 800, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxWidth) {
            height *= maxWidth / width;
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width *= maxHeight / height;
            height = maxHeight;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Failed to get canvas context'));
        
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Failed to load image for compression'));
    };
    reader.onerror = () => reject(new Error('Failed to read file for compression'));
  });
}

export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      // Remove the prefix (e.g., "data:image/jpeg;base64,")
      resolve(result.split(',')[1]);
    };
    reader.onerror = () => reject(new Error('Failed to read file for base64 conversion'));
  });
}

export async function convertToJpg(base64: string, quality = 0.9): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Failed to get canvas context'));
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('Failed to load image for conversion'));
    img.src = base64;
  });
}

// Store high-res images in IndexedDB to avoid Firestore 1MB limit
export async function storeHighResImage(id: string, base64: string) {
  await set(`img_${id}`, base64);
}

export async function getHighResImage(id: string): Promise<string | undefined> {
  return await get(`img_${id}`);
}

export async function deleteHighResImage(id: string) {
  await del(`img_${id}`);
}

/**
 * Converts any browser-readable image to a high-quality JPEG base64 string for the API.
 * Uses natural dimensions for high fidelity.
 */
export const imageToApiJpeg = async (file: File): Promise<{ base64: string, previewUrl: string }> => {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("Failed to get canvas context"));
        return;
      }
      
      ctx.drawImage(img, 0, 0);
      
      const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
      const base64 = dataUrl.split(',')[1];
      
      URL.revokeObjectURL(url);
      
      resolve({
        base64,
        previewUrl: dataUrl
      });
    };
    
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Browser could not decode this image format. Try a standard JPEG/PNG or a DNG."));
    };
    
    img.src = url;
  });
};

/**
 * Converts a base64 string (from PNG or other formats) to a JPEG data URL.
 */
export const base64ToJpegDataUrl = async (base64: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error("Canvas context failed"));
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/jpeg', 0.95));
    };
    img.onerror = reject;
    img.src = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
  });
};

/**
 * Downloads a file from a URL.
 */
export const downloadUrl = async (url: string, filename: string) => {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    }, 100);
  } catch (error) {
    console.error('Download failed', error);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
};

/**
 * Applies a text overlay to a data URL (e.g., "VIRTUALLY STAGED").
 */
export const applyOverlayToDataUrl = async (dataUrl: string, overlayType: string = 'none'): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error("Canvas context failed"));
      
      ctx.drawImage(img, 0, 0);
      
      const scale = canvas.width / 1920;
      const padding = 60 * scale;
      const x = padding;
      const y = canvas.height - padding;
      
      ctx.font = `bold ${Math.round(48 * scale)}px sans-serif`;
      ctx.fillStyle = 'white';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 12 * scale;
      ctx.shadowOffsetX = 2 * scale;
      ctx.shadowOffsetY = 2 * scale;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      
      const text = overlayType === 'virtually_staged' 
        ? "VIRTUALLY STAGED" 
        : (overlayType === 'digitally_decluttered' ? "DIGITALLY DECLUTTERED" : "DIGITALLY ENHANCED");
      
      ctx.fillText(text, x, y);
      
      resolve(canvas.toDataURL('image/jpeg', 0.95));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
};
