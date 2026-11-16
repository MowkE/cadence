# Privacy

Last updated 16 November 2026. Applies to Cadence 3.9.1, the current version. What the next version changes is at the end.

Cadence is made and run by one person (MowkE on GitHub). There is no company behind it and no
business model built on your data. This page says what the app reads, what it keeps, what leaves
your computer, and who can see it. It was written from a line by line audit of the code, and where
the app does something you might not like, it says so.

## The short version

- No analytics, no telemetry, no crash reports, no ads. Nothing reports how you use the app.
- Nothing is sold or shared for marketing. There is nobody to sell it to.
- The app has to know what song is playing. To fetch lyrics it sends that song's title, artist,
  album and length to a lyrics service.
- An account (Google sign in) is asked for after about five minutes of use. With an account, the
  song you are playing is shown to your friends in the app. There is no switch for that yet.
- Listen along runs through a public relay and is not encrypted. Anyone who has the session code
  can see what the session is playing.
- Your listening statistics stay on your computer unless you choose to send a recap to a friend.
- There is no delete button for an account in this version. The next version adds one.

## What Cadence reads on your computer

**What is playing.** This is the point of the app. About every two seconds it reads the current
song, artist, album, artwork, position and whether it is paused.

- Mac: from the Spotify or Music app through Apple's automation (macOS asks you first), from TIDAL
  through the system's Now Playing information, and from a YouTube Music tab in Chrome, Brave,
  Edge, Arc, Vivaldi, Chromium or Safari. For the tab, Cadence looks at the addresses of your open
  tabs to find music.youtube.com and reads the song details from that page only. It needs the
  browser's "Allow JavaScript from Apple Events" setting, which you switch on yourself.
- Windows: from the system's media sessions. In Auto, if no music app is playing, it can pick up
  another media session, including a video in a browser, and treat it as the song.
- Linux: from MPRIS, the standard way players announce what they play.

**How bright the screen is behind the overlay.** With Contrast on Auto (the default), every few
seconds the app takes a very small picture of the display (160 by 100 pixels), works out whether
the area behind the overlay is light or dark, and throws the picture away. The picture is never
saved and never sent. On Mac this needs Screen Recording permission; say no and the app uses your
system theme instead. On Linux with Wayland the screen is never read.

**Where the cursor is.** Only whether it is over the overlay, so the buttons can appear.

**The clipboard.** Written when you press a copy button. Read once, only to clear a sign in code
you pasted.

**Not read at all.** No keystrokes. No microphone or system audio (the visualizer is drawn from
the lyric timing, not from sound). No screenshots that are kept. No browsing history. No files
other than images you add to Remix yourself.

## What stays on your computer

Everything below lives in the app's data folder and nowhere else.

- Your settings and looks.
- Sign in tokens for your Cadence account, and for Spotify if you added your own Spotify keys.
  These are plain files that only your user account on the computer can read. They are not
  encrypted.
- Listening statistics: for each month, the songs you played with artist, artwork link, play count
  and listening time. These are kept until you delete them. They are what the listening card is
  made from.
- Images you added to Remix.

The folder is `~/Library/Application Support/spotify-overlay` on Mac, `%APPDATA%\spotify-overlay`
on Windows and usually `~/.config/spotify-overlay` on Linux. Deleting it resets Cadence completely.
There is no button in the app that clears statistics yet.

## What leaves your computer

| Where it goes | What is sent | When |
|---|---|---|
| LRCLIB (lrclib.net) | Song title, artist, album, length | Every song, to find lyrics |
| Genius (genius.com) | Artist and title | Only when LRCLIB has no lyrics |
| Apple iTunes Search, Deezer | Artist and title | To find artwork, for players that do not supply it |
| Google Translate | The lyric text | Only if you switch lyric translation on (off by default) |
| Google Fonts | A request for the typefaces | Every launch |
| GitHub | A request for the latest version, the announcement and a short public list of unlocked handles | Shortly after launch and every few hours |
| Google Firebase | Your account data and friends features (next section). Also one request at every launch, signed in or not, asking whether sign in is available | With an account |
| ntfy.sh | Listen along sessions (see below) | Only while you host or join a session |
| Spotify | Requests made with your own Spotify keys | Only if you added keys |
| YouTube Music, iTunes Search | Artist and title, to find the host's song on your service | Only as a listen along guest |

Like any internet request, each of these lets that service see your IP address. Cadence adds no
identifier of its own to the lyric, artwork, font or update requests.

## Accounts

After about five minutes of use Cadence asks you to sign in with Google and keeps asking until you
do. Listen along and the friends features need an account.

**What Google hands over:** your name, email address, profile picture link and an account id.

**What is stored in the cloud database (Google Firebase):**

- Your profile: display name, @handle, picture link, the date you joined.
- Your friends list and pending friend requests.
- Your status: the song you are playing now (title, artist, artwork link), whether it is playing,
  the session code if you are hosting, which friends may add to your queue, the app version, and
  when it last changed. It is updated automatically, at most every 45 seconds.
- Your messages with friends: text, songs and lyric lines you send, and recaps you choose to share.
- Who invited whom.

**Your email address** is not stored in that database and is not shown to anyone in the app. It is
held by Firebase Authentication, where I, as the owner of the project, can see the list of accounts
with their email, sign up date and last sign in date. The app uses it for nothing else.

**Who can see what:**

- Someone signed in who knows your @handle can look up your profile: display name, @handle,
  picture link and join date. That is how adding a friend works. Profiles cannot be listed or
  searched in bulk.
- Your friends can see your status. It is removed when you sign out. It is not removed when you
  quit the app, so your last song stays there; the app stops showing it to friends after three
  minutes.
- Messages can be read by the two people in the conversation. They cannot be edited or deleted in
  the app today.
- Messages are not end to end encrypted. As the owner of the Firebase project I am technically
  able to read anything in the database.

## Listen along

Sessions go through ntfy.sh, a public relay service run by someone else. While you host, your app
publishes the song (title, artists, album, artwork link, length), the position, whether it is
playing, and your @handle. Guests publish their @handle and picture link, song requests, votes and
game answers.

This traffic is protected in transit by HTTPS but is not encrypted beyond that. The session code is
the only key: anyone who has it can read the session and post to it. While you host, the code is
also visible to your Cadence friends so they can join. The app asks the relay for the last twelve
hours of a session's messages; how long ntfy.sh actually keeps them is up to ntfy.sh. You can point
Cadence at your own ntfy server (see the README).

## What is not collected

- No usage analytics, telemetry or crash reports of any kind.
- No advertising identifiers.
- No list of what you listen to, other than the single lookups above and the status your friends
  see while you are signed in.
- Your statistics and recaps are computed on your computer and stay there unless you send one.

## Deleting your data

- **On your computer:** delete the data folder named above.
- **Signing out** removes your status from the cloud and the sign in token from your computer.
  It does not delete your account.
- **Your account:** this version has no delete button. The next version adds "Delete account" in
  Settings, which removes everything the cloud holds about you. If you need an account removed
  before then, ask in the Discord or open an issue on GitHub with your @handle.

## Children

Cadence is not aimed at children under 13.

## Changes

If what the app does with data changes, this page changes with it and the date at the top moves.

## Contact

The Discord (https://discord.gg/DA5NeAxdhy) or an issue at https://github.com/MowkE/cadence.

## What the next version changes

These are built and tested, and ship with the next release. This page will be updated the same day.

- **Delete account** in Settings removes your status, friendships, requests, conversations, invite
  records, profile, @handle and the sign in record. "Delete my listening statistics" clears the
  local statistics.
- **Profiles can no longer be listed.** They can only be looked up one at a time by @handle. This
  part is already live, because it is a rule on the server.
- **A switch for "Show friends what I am playing"**, and the status is deleted when you quit.
- **You can delete a message you sent**, and removing a friend deletes the conversation for both.
- **Listen along is encrypted end to end** with a key made from the session code, so the relay
  cannot read it. A switch keeps the session code out of your status while you host.
- **Sign in tokens are encrypted** with the system's secure storage on Windows and Linux. On Mac
  they stay a file only your user account can read, because the Mac keychain asks an unsigned app
  for your password after every update.
- **Modes** (a study timer, pings from your own coding tools) keep their data on your computer. A
  shared study timer travels through the same encrypted listen along channel.
