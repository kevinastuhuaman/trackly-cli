# Browser upload contract

Use semantic browser controls only. Coordinates, text injection, and a visible filename without committed input state are not upload proof.

1. Discover the exact attachment control semantically.
2. Open its file chooser through the browser adapter.
3. Use the adapter's advertised `setFiles` capability with the immediately verified local path.
4. Verify the employer-facing filename exactly matches the prepared user-facing filename and contains no cache identifier.
5. Recheck contact and parser-modified fields after the upload settles.

Require all five proofs: `semantic_control_discovered`, `file_chooser_opened`, `set_files_succeeded`, `user_facing_filename_committed`, and `parser_fields_rechecked`. Fail closed when the active browser surface cannot prove any step. Never substitute an undocumented browser primitive.
