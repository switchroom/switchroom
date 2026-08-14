- **voice: the TTS audio-degradation counters now actually reach the `/tts`
  caller, as `X-Voice-Hard-Cuts` and `X-Voice-Unchunked-Pieces` (#4716).**
  #4695 said `hardCuts` / `unchunkedPieces` were "counted into the `/tts`
  response meta" so the condition "stops being invisible", and the code
  carried a comment saying the same. Neither was true: `_handle_tts` emitted
  only `X-Voice-Duration-Ms`, `X-Voice-Audio-Seconds` and `X-Voice-Voice`, and
  dropped the rest of the meta dict — so a mid-word phoneme cut or an
  unphonemizable piece reached the container's stderr and nowhere else, and
  only when non-zero. Found by capturing full response headers on live `/tts`
  probes during v0.21.11 release validation. Both counters are now sent on
  every 200, including `0`: an absent header means an old sidecar, never a
  clean request. No caller was reading them yet, so nothing changes for
  existing clients.
