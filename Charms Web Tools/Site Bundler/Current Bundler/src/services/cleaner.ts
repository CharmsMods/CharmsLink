import type { CleanerScanSummary } from "../types";

export interface CleanerOptions {
  skipExisting: boolean;
  onLog: (message: string, type?: "info" | "error" | "success") => void;
}

export const scanDirectory = async (
  sourceHandle: FileSystemDirectoryHandle,
  destinationHandle?: FileSystemDirectoryHandle
): Promise<CleanerScanSummary> => {
  const summary: CleanerScanSummary = {
    files: 0,
    directoriesKept: 0,
    emptyDirectories: 0,
    collisions: 0
  };

  const walk = async (source: FileSystemDirectoryHandle, destination?: FileSystemDirectoryHandle): Promise<boolean> => {
    let hasFiles = false;
    for await (const [name, handle] of source.entries()) {
      if (handle.kind === "directory") {
        const childDestination =
          destination && "getDirectoryHandle" in destination
            ? await destination.getDirectoryHandle(name, { create: true })
            : undefined;
        const childHasFiles = await walk(handle, childDestination);
        if (childHasFiles) {
          summary.directoriesKept += 1;
          hasFiles = true;
        } else {
          summary.emptyDirectories += 1;
        }
        continue;
      }

      summary.files += 1;
      hasFiles = true;
      if (destination) {
        try {
          await destination.getFileHandle(name, { create: false });
          summary.collisions += 1;
        } catch {
          // Destination file does not exist.
        }
      }
    }
    return hasFiles;
  };

  await walk(sourceHandle, destinationHandle);
  return summary;
};

export const copyDirectory = async (
  sourceHandle: FileSystemDirectoryHandle,
  destinationHandle: FileSystemDirectoryHandle,
  options: CleanerOptions
) => {
  const walk = async (source: FileSystemDirectoryHandle, destination: FileSystemDirectoryHandle, path = ""): Promise<boolean> => {
    let hasFiles = false;

    for await (const [name, handle] of source.entries()) {
      if (handle.kind === "directory") {
        const childDestination = await destination.getDirectoryHandle(name, { create: true });
        const childHasFiles = await walk(handle, childDestination, `${path}${name}/`);
        if (childHasFiles) {
          hasFiles = true;
        } else {
          options.onLog(`SKIPPED EMPTY: ${path}${name}/`);
        }
        continue;
      }

      hasFiles = true;
      try {
        let destinationFile: FileSystemFileHandle;
        try {
          destinationFile = await destination.getFileHandle(name, { create: false });
          if (options.skipExisting) {
            options.onLog(`SKIPPED EXISTING: ${path}${name}`);
            continue;
          }
        } catch {
          destinationFile = await destination.getFileHandle(name, { create: true });
        }

        const sourceFile = await handle.getFile();
        const writable = await destinationFile.createWritable();
        await writable.write(sourceFile);
        await writable.close();
        options.onLog(`COPIED: ${path}${name}`, "success");
      } catch (error) {
        options.onLog(`FAILED: ${path}${name} (${error instanceof Error ? error.message : String(error)})`, "error");
      }
    }

    return hasFiles;
  };

  await walk(sourceHandle, destinationHandle);
};
