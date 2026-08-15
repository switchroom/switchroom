- **telegram: sanitise lone surrogates before the wire so approval cards deliver (#4728)** —
  A JavaScript string is UTF-16 and may carry a LONE SURROGATE, which has no
  valid UTF-8 encoding; `JSON.stringify` emits it as a `\udXXX` escape rather
  than throwing, so the bad body reached Telegram, which rejected the whole
  send with `400 Bad Request: strings must be encoded in UTF-8` — and the
  approval card was silently dropped, leaving a gated tool call with no human
  in front of it. The repair now happens once, in the grammy API-transformer
  layer that every outbound call must transit, over the whole payload (button
  labels and captions included) rather than at each individual truncation
  site. Forum-topic creation (`switchroom topics sync`) POSTs outside the bot
  and so outside that layer, and now repairs the configured `topic_name` the
  same way instead of failing the whole sync on the same 400.
