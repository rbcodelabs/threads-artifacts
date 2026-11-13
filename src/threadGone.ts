/**
 * Shown when the thread that created a design is gone. The host's archive path ends in deleteThread, so an
 * archived thread is indistinguishable from a deleted one (get() returns null, send() rejects THREAD_NOT_FOUND);
 * the wording names both. Shared so intake and the send coordinator never drift apart.
 */
export const THREAD_GONE_MESSAGE = 'The thread that created this design was archived or deleted, so the comment could not be sent.';
