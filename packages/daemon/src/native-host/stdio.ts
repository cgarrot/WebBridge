/**
 * Chrome Native Messaging uses a length-prefixed JSON protocol:
 * - First 4 bytes: uint32 LE message length
 * - Remaining bytes: UTF-8 JSON payload
 */

export function readMessage(
  stream: NodeJS.ReadableStream
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onReadable = () => {
      const header = stream.read(4) as Buffer | null;
      if (!header) return;

      stream.removeListener("readable", onReadable);

      const length = header.readUInt32LE(0);
      if (length > 1024 * 1024) {
        reject(new Error(`Message too large: ${length} bytes`));
        return;
      }

      const body = stream.read(length) as Buffer | null;
      if (body) {
        try {
          resolve(JSON.parse(body.toString("utf-8")));
        } catch (err) {
          reject(err);
        }
      } else {
        const onData = () => {
          const data = stream.read(length) as Buffer | null;
          if (data) {
            stream.removeListener("readable", onData);
            try {
              resolve(JSON.parse(data.toString("utf-8")));
            } catch (err) {
              reject(err);
            }
          }
        };
        stream.on("readable", onData);
      }
    };

    stream.on("readable", onReadable);
    stream.on("end", () => reject(new Error("stdin closed")));
    stream.on("error", reject);
  });
}

export function writeMessage(
  stream: NodeJS.WritableStream,
  message: unknown
): void {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  stream.write(header);
  stream.write(body);
}
