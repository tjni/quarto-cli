/*
 * process.ts
 *
 * Copyright (C) 2020-2022 Posit Software, PBC
 */

import { MuxAsyncIterator, pooledMap } from "async";
import { debug, info } from "../deno_ral/log.ts";
import { onCleanup } from "./cleanup.ts";
import { ProcessResult } from "./process-types.ts";

const processList = new Map<number, Deno.ChildProcess>();
let processCount = 0;
let cleanupRegistered = false;

export function registerForExitCleanup(process: Deno.ChildProcess) {
  const thisProcessId = ++processCount; // don't risk repeated PIDs
  processList.set(thisProcessId, process);
  return thisProcessId;
}

export function unregisterForExitCleanup(processId: number) {
  processList.delete(processId);
}

function ensureCleanup() {
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    onCleanup(() => {
      for (const process of processList.values()) {
        try {
          process.kill();
          // process.close();
        } catch (error) {
          info("Error occurred during cleanup: " + error);
        }
      }
    });
  }
}

export type ExecProcessOptions = Deno.CommandOptions & {
  cmd: string;
};

export async function execProcess(
  options: ExecProcessOptions,
  stdin?: string,
  mergeOutput?: "stderr>stdout" | "stdout>stderr",
  stderrFilter?: (output: string) => string,
  respectStreams?: boolean,
  timeout?: number,
): Promise<ProcessResult> {
  const withTimeout = <T>(promise: Promise<T>): Promise<T> => {
    return timeout
      ? Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Process timed out")), timeout)
        ),
      ]) as Promise<T>
      : promise;
  };
  ensureCleanup();
  // define process
  try {
    // If the caller asked for stdout/stderr to be directed to the rid of an open
    // file, just allow that to happen. Otherwise, specify piped and we will implement
    // the proper behavior for inherit, etc....
    debug(`[execProcess] ${[options.cmd, ...(options.args || [])].join(" ")}`);
    const denoCmd = new Deno.Command(options.cmd, {
      ...options,
      stdin: stdin !== undefined ? "piped" : options.stdin,
      stdout: typeof (options.stdout) === "number" ? options.stdout : "piped",
      stderr: typeof (options.stderr) === "number" ? options.stderr : "piped",
    });
    const process = denoCmd.spawn();
    const thisProcessId = registerForExitCleanup(process);

    if (stdin !== undefined) {
      const stdinWriter = process.stdin.getWriter();
      if (!process.stdin) {
        unregisterForExitCleanup(thisProcessId);
        throw new Error("Process stdin not available");
      }
      // write in 4k chunks (deno observed to overflow at > 64k)
      const kWindowSize = 4096;
      const buffer = new TextEncoder().encode(stdin);
      let offset = 0;
      while (offset < buffer.length) {
        const end = Math.min(offset + kWindowSize, buffer.length);
        const window = buffer.subarray(offset, end);
        await stdinWriter.write(window);
        offset += window.byteLength;
      }
      stdinWriter.releaseLock();
      process.stdin.close();
    }

    let stdoutText = "";
    let stderrText = "";

    // If the caller requests, merge the output into a single stream. This single stream will
    // follow the runoption for that stream (e.g. inherit, pipe, etc...)
    if (mergeOutput) {
      // This multiplexer that holds the async streams and merges their results
      const multiplexIterator = new MuxAsyncIterator<
        Uint8Array
      >();

      // Add streams to the multiplexer
      const addStream = (
        iterator: AsyncIterableIterator<Uint8Array<ArrayBuffer>>,
        filter?: (output: string) => string,
      ) => {
        const streamIter = filter
          ? filteredAsyncIterator(iterator, filter)
          : iterator;
        multiplexIterator.add(streamIter);
      };

      addStream(process.stdout.values());
      addStream(process.stderr.values(), stderrFilter);

      // Process the output
      const allOutput = await processOutput(
        multiplexIterator,
        mergeOutput === "stderr>stdout" ? options.stdout : options.stderr,
      );

      // Provide the output in whichever result the user requested
      if (mergeOutput === "stderr>stdout") {
        stdoutText = allOutput;
      } else {
        stderrText = allOutput;
      }

      // Close the streams
      // FIXME: In Deno 2 we get ReadableStreams which do not have a close method?
      //
      // const closeStream = (stream: ReadableStream<Uint8Array<ArrayBuffer>> | null) => {
      //   if (stream) {
      //     stream.close();
      //   }
      // };
      // closeStream(process.stdout);
      // closeStream(process.stderr);
    } else {
      // Process the streams independently
      const promises: Promise<void>[] = [];

      if (process.stdout !== null) {
        promises.push(
          processOutput(
            process.stdout.values(),
            options.stdout,
            respectStreams ? "stdout" : undefined,
          ).then((text) => {
            stdoutText = text;
            // process.stdout!.close();
          }),
        );
      }

      if (process.stderr != null) {
        const iterator = stderrFilter
          ? filteredAsyncIterator(process.stderr.values(), stderrFilter)
          : process.stderr.values();
        promises.push(
          processOutput(
            iterator,
            options.stderr,
            respectStreams ? "stderr" : undefined,
          ).then((text) => {
            stderrText = text;
            // process.stderr!.close();
          }),
        );
      }
      await withTimeout(Promise.all(promises));
    }

    // await result
    const status = await withTimeout(process.output());

    // close the process
    // process.close();

    unregisterForExitCleanup(thisProcessId);

    debug(`[execProcess] Success: ${status.success}, code: ${status.code}`);

    return {
      success: status.success,
      code: status.code,
      stdout: stdoutText,
      stderr: stderrText,
    };
  } catch (e) {
    if (!(e instanceof Error)) {
      throw e;
    }
    throw new Error(`Error executing '${options.cmd}': ${e.message}`);
  }
}

export function processSuccessResult(): ProcessResult {
  return {
    success: true,
    code: 0,
  };
}

function filteredAsyncIterator(
  iterator: AsyncIterableIterator<Uint8Array>,
  filter: (output: string) => string,
): AsyncIterableIterator<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return pooledMap(1, iterator, (data: Uint8Array) => {
    return Promise.resolve(
      encoder.encode(filter(decoder.decode(data))),
    );
  });
}

// Processes ouptut from an interator (stderr, stdout, etc...)
async function processOutput(
  iterator: AsyncIterable<Uint8Array>,
  output?: "piped" | "inherit" | "null" | number,
  which?: "stdout" | "stderr",
): Promise<string> {
  const decoder = new TextDecoder();
  let outputText = "";
  for await (const chunk of iterator) {
    if (output === "inherit" || output === undefined) {
      if (which === "stdout") {
        Deno.stdout.writeSync(chunk);
      } else if (which === "stderr") {
        Deno.stderr.writeSync(chunk);
      } else {
        info(decoder.decode(chunk), { newline: false });
      }
    }
    const text = decoder.decode(chunk);
    outputText += text;
  }
  return outputText;
}
