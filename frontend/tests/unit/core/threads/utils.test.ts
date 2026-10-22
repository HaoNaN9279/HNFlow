import type { Message } from "@langchain/langgraph-sdk";
import { expect, test } from "@rstest/core";

import type { AgentThread } from "@/core/threads/types";
import {
  isThreadPinned,
  sortPinnedThreads,
  textOfMessage,
  THREAD_PINNED_METADATA_KEY,
} from "@/core/threads/utils";

function makeThread(
  threadId: string,
  metadata: Record<string, unknown> = {},
): AgentThread {
  return {
    thread_id: threadId,
    metadata,
    values: { title: threadId },
  } as unknown as AgentThread;
}

test("reads pinned thread metadata strictly from the pinned metadata key", () => {
  expect(
    isThreadPinned(
      makeThread("pinned", { [THREAD_PINNED_METADATA_KEY]: true }),
    ),
  ).toBe(true);
  expect(
    isThreadPinned(
      makeThread("false", { [THREAD_PINNED_METADATA_KEY]: false }),
    ),
  ).toBe(false);
  expect(
    isThreadPinned(
      makeThread("truthy", { [THREAD_PINNED_METADATA_KEY]: "true" }),
    ),
  ).toBe(false);
  expect(isThreadPinned(makeThread("legacy-bare-key", { pinned: true }))).toBe(
    false,
  );
  expect(isThreadPinned(makeThread("missing"))).toBe(false);
});

test("sortPinnedThreads keeps pinned threads first without reordering groups", () => {
  const threads = [
    makeThread("recent-1"),
    makeThread("pinned-1", { [THREAD_PINNED_METADATA_KEY]: true }),
    makeThread("recent-2"),
    makeThread("pinned-2", { [THREAD_PINNED_METADATA_KEY]: true }),
  ];

  expect(sortPinnedThreads(threads).map((thread) => thread.thread_id)).toEqual([
    "pinned-1",
    "pinned-2",
    "recent-1",
    "recent-2",
  ]);
});

test("textOfMessage concatenates object and bare-string content parts", () => {
  // Gemini's finalized shape: first signed {type:text} block + bare-string
  // continuation. textOfMessage joins flat ("") for single-line consumers.
  const message = {
    id: "ai-1",
    type: "ai",
    content: [
      {
        type: "text",
        text: "First block.",
        extras: { signature: "abc123" },
        index: 0,
      },
      " Continuation as a bare string.",
    ],
  } as unknown as Message;

  expect(textOfMessage(message)).toBe(
    "First block. Continuation as a bare string.",
  );
});

test("textOfMessage returns null when array content has no text", () => {
  const message = {
    id: "ai-1",
    type: "ai",
    content: [{ type: "image_url", image_url: "https://example.com/x.png" }],
  } as unknown as Message;

  expect(textOfMessage(message)).toBeNull();
});
