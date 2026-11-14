export const DOCUMENT_FILE_ACCEPT =
  "application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,text/plain";
export const MAX_DOCUMENT_UPLOAD_BYTES = 25 * 1024 * 1024;

const extensions: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  txt: "text/plain",
};

export function documentFileType(file: File): string {
  return file.type || extensions[file.name.split(".").pop()?.toLowerCase() ?? ""] || "";
}

export function documentFileError(file: File): string | null {
  if (!DOCUMENT_FILE_ACCEPT.split(",").includes(documentFileType(file))) {
    return "Choose a PDF, JPEG, PNG, WebP, HEIC/HEIF image or plain-text document.";
  }
  if (file.size === 0) return "This file is empty. Choose a file with content.";
  if (file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
    return "This file is larger than the 25 MB upload limit. Choose a smaller file.";
  }
  return null;
}

export function documentUploadFile(file: File): File {
  return file.type ? file : new File([file], file.name, {
    type: documentFileType(file),
    lastModified: file.lastModified,
  });
}
