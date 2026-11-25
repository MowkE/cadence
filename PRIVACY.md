# Privacy

Last updated 25 November 2026.

Applies to Cadence from version 3.10.0.

Cadence is made and run by one person (MowkE on GitHub). There is no company behind it and no
business model built on your data. This page says what the app reads, what it keeps, what leaves
your computer, and who can see it. It was written from a line by line audit of the code.

## The short version

- No analytics, no telemetry, no crash reports, no ads. Nothing reports how you use the app.
- Nothing is sold or shared for marketing. There is nobody to sell it to.
- The app has to know what song is playing. To fetch lyrics it sends that song's title, artist,
  album and length to a lyrics service.
- An account (Google sign in) is asked for after about five minutes of use. With an account your
  friends can see the song you are playing. You can switch that off.
- Listen along is encrypted end to end. The relay it runs through cannot read it.
- Your listening statistics stay on your computer unless you choose to send a recap to a friend.
- You can delete your account, and everything the cloud holds about you, from inside the app.

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

**The clipboard.** Written when you press a copy button. Read when you press a button that takes
text from it (your own lyrics for a song, a quote for Inspiration mode), and once to clear a sign
in code you pasted.

**Only if you turn these on:**

- *Turn on with these apps* (Dev mode) reads the name of the app in front, so the mode
  can switch itself. It is not saved or sent.
- *Watch ChatGPT, Claude and Grok tabs* (Dev mode, Mac, off by default) looks at the addresses and
  titles of your open tabs to find those sites and checks whether an answer is still being written.
  It reads no conversation text and sends nothing anywhere.
- Dev mode's set up buttons add lines to your Claude Code or Codex settings, only when you press
  them, and keep a copy of the file first. Dev mode listens for pings on your own computer only
  (127.0.0.1) and needs a key that never leaves your machine.

**Not read at all.** No keystrokes. No microphone or system audio (the visualizer is drawn from
the lyric timing, not from sound). No screenshots that are kept. No browsing history. No files
other than the images you add to Remix and the pictures, videos and sounds you add to Inspiration
mode yourself.

## What stays on your computer

Everything below lives in the app's data folder and nowhere else.

- Your settings and looks.
- Sign in tokens for your Cadence account, and for Spotify if you added your own Spotify keys. On
  Windows and Linux these are encrypted with the system's secure storage, tied to your login. On
  Mac they are a file that only your user account can read: Cadence is not signed with an Apple
  developer certificate, and for an unsigned app the Mac keychain would ask for your password after
  every update.
- Listening statistics: for each month, the songs you played with artist, artwork link, play count
  and listening time. They are what the listening card is made from. Settings, Account, "Delete my
  listening statistics" clears them.
- Study mode's count of finished rounds and focus minutes per day.
- Images you added to Remix.
- Inspiration mode's pieces: the quotes you typed or took from your clipboard, and a copy of each
  picture, video and sound you picked. They are shown on your overlay and nothing else is done
  with them: no lookups, no uploads, never sent anywhere.

The folder is `~/Library/Application Support/spotify-overlay` on Mac, `%APPDATA%\spotify-overlay`
on Windows and usually `~/.config/spotify-overlay` on Linux. Deleting it resets Cadence completely.

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
| ntfy.sh | Encrypted listen along sessions (see below) | Only while you host or join a session |
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
- Your status, if "Show friends what I am playing" is on (it is on until you switch it off): the
  song you are playing now (title, artist, artwork link), whether it is playing, the session code
  if you are hosting and letting friends join, which friends may add to your queue, the app
  version, and when it last changed. It is updated at most every 45 seconds and is deleted when you
  quit the app, sign out, or switch it off.
- Your messages with friends: text, songs and lyric lines you send, and recaps you choose to share.
- Who invited whom.

**Your email address** is not stored in that database and is not shown to anyone in the app. It is
held by Firebase Authentication, where I, as the owner of the project, can see the list of accounts
with their email, sign up date and last sign in date. I use it for nothing.

**Who can see what:**

- Someone who knows your @handle can look up your profile: display name, @handle, picture link and
  join date. That is how adding a friend works. Profiles cannot be listed or searched in bulk.
- Your friends can see your status while it is switched on.
- Messages can be read by the two people in the conversation. You can delete a message you sent.
  Removing a friend deletes the conversation for both of you.
- Messages between friends are stored in the database and are not end to end encrypted. As the
  owner of the Firebase project I am technically able to read anything in it.

## Listen along

Sessions go through ntfy.sh, a public relay service run by someone else. Everything a session
sends (the song, the position, @handles, requests, votes, game answers, a shared study timer) is
encrypted on your computer with a key made from the session code, and only decrypted on the
computers of people who have the code. The relay sees a meaningless channel name, how big the
messages are and when they are sent, and the IP addresses of the people in the session. It cannot
read them.

The session code is the key. Anyone you give it to can read the session and take part, so share it
like an invite. While you host, your friends can see the code in your status so they can join;
"Friends can see and join" in the session tab switches that off.

One exception: if you join a host who is still on an older version of Cadence, that session is not
encrypted, and the app tells you so.

## What is not collected

- No usage analytics, telemetry or crash reports of any kind.
- No advertising identifiers.
- No list of what you listen to, other than the single lookups above and the status your friends
  see while it is switched on.
- Your statistics and recaps are computed on your computer and stay there unless you send one.

## Deleting your data

- **Your account:** Settings, Account, "Delete account". It deletes your status, friendships,
  friend requests, every conversation you are in with its messages, your invite records, your
  profile, your @handle, and then the sign in record itself. Google may ask you to sign in once
  more to confirm the last step. Your @handle becomes free for someone else.
- **A message:** Delete, on a message you sent.
- **Your statistics:** Settings, Account, "Delete my listening statistics".
- **Everything on your computer:** delete the data folder named above.
- **Signing out** removes your status from the cloud and the sign in token from your computer.
  It does not delete your account.

## Children

Cadence is not aimed at children under 13 and I do not knowingly keep accounts for them.

## Changes

If what the app does with data changes, this page changes with it and the date at the top moves.

## Contact

The Discord (https://discord.gg/DA5NeAxdhy) or an issue at https://github.com/MowkE/cadence.
