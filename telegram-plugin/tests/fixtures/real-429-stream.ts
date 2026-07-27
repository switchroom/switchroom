/**
 * The real 2026-07 Telegram 429 stream, verbatim.
 *
 * Every `telegram gateway: 429 …` line one production agent's gateway emitted
 * between 2026-07-12 and 2026-07-27, extracted from `gateway-supervisor.log`
 * (plus its rotated `.gz`) as
 * `[<iso>] … (flood ban of <n>s | rate limited, waiting <n>s)`.
 * 170 observations; nothing sampled, synthesised, or reordered. Timestamps and
 * `retry_after` values only — no ids, no chat content.
 *
 * This is the fixture the flood-pressure classifier is proved against, because
 * the shape is the whole problem:
 *
 *   - 72 of the 170 are short rate nudges, the largest being 5s. They are
 *     invisible to the operator: `retryApiCall` sleeps them and the send lands.
 *   - The smallest `retry_after` belonging to a real ban is 282s. There is no
 *     observed traffic between 5s and 282s, so the benign band is wide.
 *   - 87 of the remaining observations are ONE ban (2026-07-27T20:19:56Z,
 *     `retry_after=15908`) re-observed every ~5s as it counted down. Any signal
 *     built on event COUNT explodes here, during the outage it should have
 *     predicted.
 *
 * The four real bans:
 *   2026-07-12T05:06:46Z  retry_after=21397  (5.9h)
 *   2026-07-13T03:17:47Z  retry_after=27951  (7.8h)
 *   2026-07-25T23:43:07Z  retry_after=3713   (62min)
 *   2026-07-27T20:19:56Z  retry_after=15908  (4.4h)  ← the incident
 *
 * Generated once from the live logs; do not edit by hand.
 */

/** One observed 429: ISO timestamp + Telegram's `parameters.retry_after`. */
export interface RawFlood429 {
  iso: string
  ts: number
  retryAfterSec: number
}

const RAW: ReadonlyArray<{ iso: string; retryAfterSec: number }> = [
  { iso: "2026-07-12T00:43:42.969Z", retryAfterSec: 3 },
  { iso: "2026-07-12T00:43:52.754Z", retryAfterSec: 3 },
  { iso: "2026-07-12T05:06:46.641Z", retryAfterSec: 21397 },
  { iso: "2026-07-12T23:39:24.579Z", retryAfterSec: 436 },
  { iso: "2026-07-13T00:37:18.647Z", retryAfterSec: 563 },
  { iso: "2026-07-13T00:37:19.162Z", retryAfterSec: 563 },
  { iso: "2026-07-13T01:42:00.795Z", retryAfterSec: 283 },
  { iso: "2026-07-13T01:42:01.269Z", retryAfterSec: 282 },
  { iso: "2026-07-13T01:42:01.741Z", retryAfterSec: 282 },
  { iso: "2026-07-13T02:39:43.308Z", retryAfterSec: 425 },
  { iso: "2026-07-13T03:17:47.764Z", retryAfterSec: 27951 },
  { iso: "2026-07-14T01:00:55.498Z", retryAfterSec: 3 },
  { iso: "2026-07-14T01:01:05.283Z", retryAfterSec: 3 },
  { iso: "2026-07-14T01:42:51.141Z", retryAfterSec: 3 },
  { iso: "2026-07-14T01:43:00.941Z", retryAfterSec: 3 },
  { iso: "2026-07-14T10:17:08.494Z", retryAfterSec: 3 },
  { iso: "2026-07-14T10:17:18.394Z", retryAfterSec: 3 },
  { iso: "2026-07-15T06:47:31.287Z", retryAfterSec: 3 },
  { iso: "2026-07-15T11:28:14.054Z", retryAfterSec: 3 },
  { iso: "2026-07-15T11:28:23.913Z", retryAfterSec: 3 },
  { iso: "2026-07-16T01:48:28.656Z", retryAfterSec: 3 },
  { iso: "2026-07-16T01:48:38.477Z", retryAfterSec: 3 },
  { iso: "2026-07-16T02:37:16.659Z", retryAfterSec: 3 },
  { iso: "2026-07-16T02:37:26.496Z", retryAfterSec: 3 },
  { iso: "2026-07-16T07:39:14.389Z", retryAfterSec: 3 },
  { iso: "2026-07-16T07:39:24.206Z", retryAfterSec: 3 },
  { iso: "2026-07-16T19:29:32.965Z", retryAfterSec: 3 },
  { iso: "2026-07-16T19:29:42.817Z", retryAfterSec: 3 },
  { iso: "2026-07-16T21:32:57.539Z", retryAfterSec: 5 },
  { iso: "2026-07-17T00:04:44.818Z", retryAfterSec: 3 },
  { iso: "2026-07-17T00:04:54.594Z", retryAfterSec: 3 },
  { iso: "2026-07-17T02:45:40.820Z", retryAfterSec: 3 },
  { iso: "2026-07-17T02:45:50.608Z", retryAfterSec: 3 },
  { iso: "2026-07-17T06:10:38.674Z", retryAfterSec: 3 },
  { iso: "2026-07-17T06:10:48.510Z", retryAfterSec: 3 },
  { iso: "2026-07-17T07:55:18.855Z", retryAfterSec: 3 },
  { iso: "2026-07-17T07:55:28.640Z", retryAfterSec: 3 },
  { iso: "2026-07-17T09:21:15.798Z", retryAfterSec: 3 },
  { iso: "2026-07-18T22:35:20.897Z", retryAfterSec: 3 },
  { iso: "2026-07-19T01:25:52.829Z", retryAfterSec: 3 },
  { iso: "2026-07-19T01:26:02.649Z", retryAfterSec: 3 },
  { iso: "2026-07-19T03:29:55.399Z", retryAfterSec: 3 },
  { iso: "2026-07-19T03:30:05.203Z", retryAfterSec: 3 },
  { iso: "2026-07-19T06:05:47.796Z", retryAfterSec: 3 },
  { iso: "2026-07-19T06:05:57.632Z", retryAfterSec: 3 },
  { iso: "2026-07-19T10:21:12.347Z", retryAfterSec: 3 },
  { iso: "2026-07-19T10:21:22.178Z", retryAfterSec: 3 },
  { iso: "2026-07-19T10:21:50.826Z", retryAfterSec: 3 },
  { iso: "2026-07-19T10:22:00.651Z", retryAfterSec: 3 },
  { iso: "2026-07-19T10:22:10.486Z", retryAfterSec: 3 },
  { iso: "2026-07-19T10:47:10.609Z", retryAfterSec: 3 },
  { iso: "2026-07-19T10:47:20.439Z", retryAfterSec: 3 },
  { iso: "2026-07-19T10:47:30.277Z", retryAfterSec: 3 },
  { iso: "2026-07-20T01:40:22.311Z", retryAfterSec: 3 },
  { iso: "2026-07-20T01:40:32.183Z", retryAfterSec: 3 },
  { iso: "2026-07-20T02:26:37.436Z", retryAfterSec: 3 },
  { iso: "2026-07-20T02:26:47.514Z", retryAfterSec: 3 },
  { iso: "2026-07-21T11:14:47.910Z", retryAfterSec: 3 },
  { iso: "2026-07-21T11:14:57.729Z", retryAfterSec: 3 },
  { iso: "2026-07-21T22:59:02.412Z", retryAfterSec: 3 },
  { iso: "2026-07-21T22:59:12.189Z", retryAfterSec: 3 },
  { iso: "2026-07-23T19:58:39.060Z", retryAfterSec: 3 },
  { iso: "2026-07-24T08:22:21.126Z", retryAfterSec: 3 },
  { iso: "2026-07-24T09:00:54.528Z", retryAfterSec: 3 },
  { iso: "2026-07-24T09:01:04.413Z", retryAfterSec: 3 },
  { iso: "2026-07-24T21:47:04.852Z", retryAfterSec: 3 },
  { iso: "2026-07-24T21:49:20.213Z", retryAfterSec: 3 },
  { iso: "2026-07-24T21:49:30.004Z", retryAfterSec: 3 },
  { iso: "2026-07-24T21:49:39.786Z", retryAfterSec: 3 },
  { iso: "2026-07-25T05:24:04.941Z", retryAfterSec: 3 },
  { iso: "2026-07-25T22:50:39.203Z", retryAfterSec: 3 },
  { iso: "2026-07-25T22:50:48.981Z", retryAfterSec: 3 },
  { iso: "2026-07-25T23:43:07.861Z", retryAfterSec: 3713 },
  { iso: "2026-07-26T14:07:07.428Z", retryAfterSec: 3 },
  { iso: "2026-07-26T14:07:20.567Z", retryAfterSec: 3 },
  { iso: "2026-07-26T14:07:30.355Z", retryAfterSec: 3 },
  { iso: "2026-07-26T22:43:03.042Z", retryAfterSec: 3 },
  { iso: "2026-07-27T05:50:52.944Z", retryAfterSec: 3 },
  { iso: "2026-07-27T10:04:58.523Z", retryAfterSec: 3 },
  { iso: "2026-07-27T10:05:12.142Z", retryAfterSec: 3 },
  { iso: "2026-07-27T10:05:21.953Z", retryAfterSec: 3 },
  { iso: "2026-07-27T16:22:32.052Z", retryAfterSec: 3 },
  { iso: "2026-07-27T20:19:56.704Z", retryAfterSec: 15908 },
  { iso: "2026-07-27T20:53:27.532Z", retryAfterSec: 13897 },
  { iso: "2026-07-27T20:53:31.923Z", retryAfterSec: 13893 },
  { iso: "2026-07-27T20:53:36.919Z", retryAfterSec: 13888 },
  { iso: "2026-07-27T20:53:41.904Z", retryAfterSec: 13883 },
  { iso: "2026-07-27T20:53:46.908Z", retryAfterSec: 13878 },
  { iso: "2026-07-27T20:53:51.904Z", retryAfterSec: 13873 },
  { iso: "2026-07-27T20:53:56.914Z", retryAfterSec: 13868 },
  { iso: "2026-07-27T20:54:01.911Z", retryAfterSec: 13863 },
  { iso: "2026-07-27T20:54:06.907Z", retryAfterSec: 13858 },
  { iso: "2026-07-27T20:54:11.932Z", retryAfterSec: 13853 },
  { iso: "2026-07-27T20:54:16.925Z", retryAfterSec: 13848 },
  { iso: "2026-07-27T20:54:21.929Z", retryAfterSec: 13843 },
  { iso: "2026-07-27T20:54:26.932Z", retryAfterSec: 13838 },
  { iso: "2026-07-27T20:54:31.929Z", retryAfterSec: 13833 },
  { iso: "2026-07-27T20:54:36.940Z", retryAfterSec: 13828 },
  { iso: "2026-07-27T20:54:41.914Z", retryAfterSec: 13823 },
  { iso: "2026-07-27T20:54:46.919Z", retryAfterSec: 13818 },
  { iso: "2026-07-27T20:54:51.949Z", retryAfterSec: 13813 },
  { iso: "2026-07-27T20:54:56.911Z", retryAfterSec: 13808 },
  { iso: "2026-07-27T20:55:01.932Z", retryAfterSec: 13803 },
  { iso: "2026-07-27T20:55:06.918Z", retryAfterSec: 13798 },
  { iso: "2026-07-27T20:55:11.949Z", retryAfterSec: 13793 },
  { iso: "2026-07-27T20:55:17.011Z", retryAfterSec: 13788 },
  { iso: "2026-07-27T20:55:21.997Z", retryAfterSec: 13783 },
  { iso: "2026-07-27T20:55:26.949Z", retryAfterSec: 13778 },
  { iso: "2026-07-27T20:55:31.941Z", retryAfterSec: 13773 },
  { iso: "2026-07-27T20:55:36.943Z", retryAfterSec: 13768 },
  { iso: "2026-07-27T20:55:41.924Z", retryAfterSec: 13763 },
  { iso: "2026-07-27T20:55:46.927Z", retryAfterSec: 13758 },
  { iso: "2026-07-27T20:55:51.928Z", retryAfterSec: 13753 },
  { iso: "2026-07-27T20:55:56.922Z", retryAfterSec: 13748 },
  { iso: "2026-07-27T20:56:01.937Z", retryAfterSec: 13743 },
  { iso: "2026-07-27T20:56:06.922Z", retryAfterSec: 13738 },
  { iso: "2026-07-27T20:56:11.950Z", retryAfterSec: 13733 },
  { iso: "2026-07-27T20:56:16.950Z", retryAfterSec: 13728 },
  { iso: "2026-07-27T20:56:21.954Z", retryAfterSec: 13723 },
  { iso: "2026-07-27T20:56:26.955Z", retryAfterSec: 13718 },
  { iso: "2026-07-27T20:56:31.952Z", retryAfterSec: 13713 },
  { iso: "2026-07-27T20:56:36.954Z", retryAfterSec: 13708 },
  { iso: "2026-07-27T20:56:41.952Z", retryAfterSec: 13703 },
  { iso: "2026-07-27T20:56:46.938Z", retryAfterSec: 13698 },
  { iso: "2026-07-27T20:56:51.937Z", retryAfterSec: 13693 },
  { iso: "2026-07-27T20:56:56.942Z", retryAfterSec: 13688 },
  { iso: "2026-07-27T20:57:01.984Z", retryAfterSec: 13683 },
  { iso: "2026-07-27T20:57:06.955Z", retryAfterSec: 13678 },
  { iso: "2026-07-27T20:57:11.959Z", retryAfterSec: 13673 },
  { iso: "2026-07-27T20:57:16.976Z", retryAfterSec: 13668 },
  { iso: "2026-07-27T20:57:21.964Z", retryAfterSec: 13663 },
  { iso: "2026-07-27T20:57:26.962Z", retryAfterSec: 13658 },
  { iso: "2026-07-27T20:57:31.968Z", retryAfterSec: 13653 },
  { iso: "2026-07-27T20:57:36.960Z", retryAfterSec: 13648 },
  { iso: "2026-07-27T20:57:41.981Z", retryAfterSec: 13643 },
  { iso: "2026-07-27T20:57:46.972Z", retryAfterSec: 13638 },
  { iso: "2026-07-27T20:57:51.976Z", retryAfterSec: 13633 },
  { iso: "2026-07-27T20:57:56.966Z", retryAfterSec: 13628 },
  { iso: "2026-07-27T20:58:01.971Z", retryAfterSec: 13623 },
  { iso: "2026-07-27T20:58:07.023Z", retryAfterSec: 13618 },
  { iso: "2026-07-27T20:58:12.081Z", retryAfterSec: 13613 },
  { iso: "2026-07-27T20:58:16.975Z", retryAfterSec: 13608 },
  { iso: "2026-07-27T20:58:21.974Z", retryAfterSec: 13603 },
  { iso: "2026-07-27T20:58:26.994Z", retryAfterSec: 13598 },
  { iso: "2026-07-27T20:58:31.979Z", retryAfterSec: 13593 },
  { iso: "2026-07-27T20:58:36.977Z", retryAfterSec: 13588 },
  { iso: "2026-07-27T20:58:41.983Z", retryAfterSec: 13583 },
  { iso: "2026-07-27T20:58:46.966Z", retryAfterSec: 13578 },
  { iso: "2026-07-27T20:58:51.982Z", retryAfterSec: 13573 },
  { iso: "2026-07-27T20:58:56.984Z", retryAfterSec: 13568 },
  { iso: "2026-07-27T20:59:01.983Z", retryAfterSec: 13563 },
  { iso: "2026-07-27T20:59:06.982Z", retryAfterSec: 13558 },
  { iso: "2026-07-27T20:59:11.987Z", retryAfterSec: 13553 },
  { iso: "2026-07-27T20:59:16.995Z", retryAfterSec: 13548 },
  { iso: "2026-07-27T20:59:21.982Z", retryAfterSec: 13543 },
  { iso: "2026-07-27T20:59:26.987Z", retryAfterSec: 13538 },
  { iso: "2026-07-27T20:59:31.991Z", retryAfterSec: 13533 },
  { iso: "2026-07-27T20:59:36.994Z", retryAfterSec: 13528 },
  { iso: "2026-07-27T20:59:41.993Z", retryAfterSec: 13523 },
  { iso: "2026-07-27T20:59:47.005Z", retryAfterSec: 13518 },
  { iso: "2026-07-27T20:59:51.997Z", retryAfterSec: 13513 },
  { iso: "2026-07-27T20:59:56.996Z", retryAfterSec: 13508 },
  { iso: "2026-07-27T21:00:02.004Z", retryAfterSec: 13503 },
  { iso: "2026-07-27T21:00:07.009Z", retryAfterSec: 13498 },
  { iso: "2026-07-27T21:00:11.996Z", retryAfterSec: 13493 },
  { iso: "2026-07-27T21:00:17.016Z", retryAfterSec: 13488 },
  { iso: "2026-07-27T21:00:22.002Z", retryAfterSec: 13483 },
  { iso: "2026-07-27T21:00:27.001Z", retryAfterSec: 13478 },
  { iso: "2026-07-27T21:00:32.002Z", retryAfterSec: 13473 },
  { iso: "2026-07-27T21:00:36.999Z", retryAfterSec: 13468 },
]

export const REAL_429_STREAM: ReadonlyArray<RawFlood429> = RAW.map((e) => ({
  ...e,
  ts: Date.parse(e.iso),
}))

/** Convenience: `Date.parse` of an ISO instant, for assertion timestamps. */
export function at(iso: string): number {
  return Date.parse(iso)
}
