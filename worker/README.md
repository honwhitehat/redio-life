# Redio Life stats counter

A small Cloudflare Worker that counts visits, plays and who's listening right now, for the
dashboard at **https://radio.cybergistplanet.com/dashboard.html**. It runs on
`radio.cybergistplanet.com/api/*` and keeps its numbers in one Durable Object (a small
SQLite database). It fits in Cloudflare's free plan.

## What it counts

| On the dashboard | Where it comes from |
|---|---|
| Listening now, and which stations (also shown on the radio) | Each app checks in every minute while a station plays; anyone who hasn't checked in for 2½ minutes stops counting |
| Most listening at once | The highest "listening now" each day |
| Visitors | People told apart for one day only (see Privacy) |
| Visits | Each time the app or site is opened |
| Users all time | Each phone or browser the first time it opens the app (counting starts when this goes live). Also shown on the radio |
| Plays | A station that stayed on for 15 seconds or more, so Scan's 12-second stops don't count |
| Hours listened, busiest hours | Added up from the check-ins, in Lagos time |
| Where listeners are | The Nigerian state and country Cloudflare sees the visit coming from |
| Devices | Android app, Android browser, iPhone / iPad or computer |
| How people found it | The website a visitor came from, such as google.com or whatsapp.com |
| How long people stay | How long someone listens to one station before switching or stopping |
| Streams that failed | Stations where none of the stream links would play |

Daily numbers are kept for 400 days.

## Privacy

- No cookies. The only thing saved on the listener's phone is a yes/no that it has been counted as a
  user, so "users all time" counts each phone once. Clearing the app's data or using a new phone counts again.
- No IP addresses are stored. A visitor is told apart for one day only, by a hash of their IP
  address, browser and that day's date mixed with a secret (`SALT`). Nobody can be followed from
  one day to the next, so "Visitors" over 7 or 30 days is the daily visitors added up.
- Stations people add themselves are counted together as "Stations people added", without their names.

## Protection against fake numbers

Anyone can send requests to a public counter, so it only trusts so much from each connection
(IP address). The limits are generous, because Nigerian mobile networks put many phones behind
one address:

| Limit | Per connection | What a real listener uses |
|---|---|---|
| Events | 60 a minute | about 1 a minute |
| Listening at once | 25 | 1 |
| New visitors | 300 a day | 1 |
| Wrong dashboard keys | 20 an hour, then locked out for the rest of the hour | 0 |

Past a limit, extra events are quietly dropped and the radio carries on as normal. On top of that:

- Only stations in `stations.js` are counted, and the counter uses its own names for them, so nobody
  can put made-up names on your dashboard. Anything else shows as "Stations not in the counter's
  list yet". **After changing `stations.js`, redeploy the counter** (`npx wrangler deploy`) so new
  stations are counted under their names.
- Requests from scripts and bots (curl, Python and similar) and from other websites are ignored.
- "How people found Redio Life" only accepts real website names.

Someone with many IP addresses could still add some fake numbers. That takes real effort, and each
address can only add a little.

The radio reads its two numbers from `/api/public`, which anyone can see and which is cached for
30 seconds. It's refreshed every 2 minutes while the radio is on screen.

## Putting it live (one time)

You need Node.js and a Cloudflare account that has `cybergistplanet.com` on it.

```bash
cd worker
npm install
npx wrangler login
```

Set the two secrets. Use long random values, for example from `openssl rand -base64 32`:

```bash
npx wrangler secret put DASH_KEY
```

```bash
npx wrangler secret put SALT
```

`DASH_KEY` is what you type to open the dashboard. `SALT` is never typed anywhere; it only mixes
up the daily visitor hashes.

Then deploy (this also builds the station list from `stations.js`):

```bash
npx wrangler deploy
```

To check it's working, open the radio, play a station for 15 seconds, then open
https://radio.cybergistplanet.com/dashboard.html. You should see yourself under "Listening now".

## Changing it later

- Run `npx wrangler deploy` from `worker/` after changing `src/index.js`.
- `npx wrangler tail` shows requests as they come in.
- To try it on your computer, put `DASH_KEY="..."` and `SALT="..."` in `worker/.dev.vars`
  (git ignores this file) and run `npx wrangler dev`.

## Free plan limits

The free plan allows 100,000 requests a day. A listener uses about 60 requests an hour, so that's
roughly 1,500 listener-hours a day. Past that, extra check-ins are refused until the next day and
the radio keeps playing as normal. Cloudflare's $5 a month plan raises the limit to 10 million
requests a month.
