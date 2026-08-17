/**
 * Shared wire format for plain-text at-mention references.
 *
 * The client inserts a visually normal `@label` followed by an invisible
 * metadata suffix:
 *
 *   @DESIGN.zh.md\u2063f:%2Fabs%2Fpath\u2063
 *   @Some Session\u2063s:session-id\u2063
 *
 * The suffix is invisible in the composer, lets the client treat the whole
 * reference as one atomic unit for caret/delete/click, and lets the host
 * consumer restore the original model projection (absolute file path or
 * canonical session mention) without relying on the chip occurrence table.
 * @module dsh-at-mention/src/shared/reference-format
 */
/** Invisible separator used around the encoded payload. */
export declare const REF_MARK = "\u2063";
/** One parsed plain-text reference. */
export interface EncodedReference {
    readonly type: 'file' | 'session';
    /** Visible label, without the leading `@`. */
    readonly label: string;
    /** Decoded payload: absolute path for files, session id for sessions. */
    readonly ref: string;
    /** Offset of the leading `@` in the source text. */
    readonly start: number;
    /** Offset just past the trailing invisible marker. */
    readonly end: number;
    /** Offset just past the visible `@label` (before the invisible suffix). */
    readonly visibleEnd: number;
}
/**
 * Encode a file reference as visible `@rel` plus an invisible absolute-path
 * payload.
 */
export declare function encodeFileReference(rel: string, abs: string): string;
/**
 * Encode a session reference as visible `@label` plus an invisible session-id
 * payload.
 */
export declare function encodeSessionReference(label: string, id: string): string;
/**
 * Parse every encoded at-mention reference in a draft. Ranges are in
 * JavaScript string offsets and include the invisible suffix.
 */
export declare function parseEncodedReferences(text: string): EncodedReference[];
/**
 * Replace encoded references with their model-facing projection:
 * files become the absolute path, sessions become readable `@label`.
 */
export declare function cleanEncodedReferences(text: string): string;
