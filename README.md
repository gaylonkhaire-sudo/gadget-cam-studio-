# Gadget Cam Studio

Record every camera at once with clean audio, color and framing.

## Two ways to use it

**Browser version (works right now).** Open `Gadget Cam Studio.html` in Chrome or Edge. Nothing to install.

**Windows app (recommended for real shoots).** Adds:
- Files finished with FFmpeg at a constant frame rate, so DaVinci Resolve stays in sync on long recordings
- H.264 or H.265 encoded on your graphics hardware (AMD, NVIDIA or Intel), with software fallback
- Free disk space and time remaining while you record
- System audio straight from Windows, with no screen-share prompt
- Ctrl+Shift+R (record) and Ctrl+Shift+M (marker) from any app
- A virtual camera: Meet, Zoom, Teams and OBS see it as “OBS Virtual Camera”
- Tray icon, desktop shortcut, recordings saved to Videos\Gadget Cam Studio by default

### Get the installer from GitHub (recommended, includes the Gadget Cam Studio camera)
1. Create a free account at github.com, then click **New repository**. Name it `gadget-cam-studio`, choose **Private**, and create it.
2. On the new repository page, click **uploading an existing file**. Drag in everything inside this folder, including the hidden `.github` folder (on Windows, turn on View → Show → Hidden items first). Click **Commit changes**.
3. Open the **Actions** tab. The “Build Gadget Cam Studio” run starts by itself and takes about 10 minutes.
4. When it shows a green check, open the run and download **Gadget-Cam-Studio-Installer** under Artifacts. Unzip it and run the installer.
   If the run shows a red X, open it and send me a screenshot of the error.

### Build the Windows app on your PC (without the custom camera unless Visual Studio Build Tools are installed)
1. Install Node.js LTS from nodejs.org (if you don’t have it).
2. Open the `electron` folder and double-click **Build Windows App.bat**.
3. When it finishes, run the installer in `electron\dist`.
   Windows SmartScreen may warn because the app isn’t code-signed. Click **More info → Run anyway**.

To try it without making an installer, double-click **Try Without Installing.bat**.

## What gets saved per take
- One file per camera: `Project_T1_Camera.mp4` (identical audio in every file, so Resolve can sync by audio)
- `_vertical` files for cameras with the 9:16 copy turned on
- `_part2`, `_part3` if a camera was unplugged and came back mid-take
- `Project_T1_Resolve.fcpxml`: a timeline with every angle stacked and lined up, plus your markers
  In Resolve: File → Import → Timeline, pick the .fcpxml. If clips show as offline, choose Relink and point at the recordings folder.
- `Project_T1_markers.edl` and `.csv`: markers on their own (Resolve: right-click a timeline → Timelines → Import → Timeline Markers from EDL)
- Windows app only: originals are kept in an `Originals` subfolder after finishing. Delete them once you’re happy.

## Virtual camera and output window
- Turn on **Virtual camera** under Output in the sidebar (Windows app). In Meet, Zoom, Teams, OBS or the Windows Camera app, pick **Gadget Cam Studio**.
  This camera needs Windows 11 and is installed by the GitHub-built installer (below). When the app is closed, the camera shows a dark standby screen.
- If the Gadget Cam Studio camera isn’t installed (Windows 10, or an installer built without it), the app uses **OBS Virtual Camera** instead. That needs OBS Studio installed, but OBS doesn’t need to be open.
- Choose which camera goes out, add picture in picture, and pick 720p or 1080p in the Output panel. Press 1–9 to switch cameras.
- **Output window** works in the browser version too: a clean feed with no buttons. Add it in OBS with Window Capture, or double-click it for full screen on another screen.

## Performance
The **Load** meter in the toolbar estimates how hard this computer is working. You get a warning before adding a camera that would push it too far, with the option to add it at 720p instead. Click the meter for per-camera details and one-click fixes (1080p everywhere, 30 fps everywhere, turn off 9:16 copies). While recording, you’re told if a camera keeps dropping frames.

## Sources: cameras, phones, screens, videos and images
Click **Add a source** (or + next to Cameras):
- **Camera**: webcams, capture cards, Camo
- **Phone** (Windows app): scan the QR code, then choose **Use as camera** (up to 4K) or **Use as microphone**. New phones ask for your OK first. The pairing screen appears when the app opens; turn that off on the screen itself.
- **Screen or app window**: share a whole screen or one app, with or without its sound
- **Video file**: for reactions; play/pause on the preview, “Play when recording starts”, its sound goes into the mixer
- **Image**: title cards, logos, product shots
Every source can use looks, framing and LUTs, gets its own recording, and can be the main picture or the inset on the output.

## Picture-in-picture and reactions
In the Output panel: choose the **Main** source and an **Inset**. Drag the inset on the preview, or pick a corner. Change its size, shape (rounded, square, circle), border and shadow, and swap main and inset in one click.
Turn on **Record the output too** to save the finished picture-in-picture video as its own file (named “…Output”). A reaction video is: clip as Main, your camera as Inset, Record the output too.
The **floating mini preview** button (toolbar, or Output panel) shows the output in a small always-on-top window you can keep over other apps.

## Mixes and ducking (keep your voice on top)
Each audio input has a **role** tag on its strip: Voice, Game, Clip, Music or Other. Mics start as Voice, screen and system audio as Game, video files as Clip. Click the tag to change it.
The **Mix** menu in the audio bar sets every role’s level in one click:
- **Voice first**: everything else well under your voice
- **Gaming**: game −10 dB, and it dips while you talk
- **Reaction**: clip −6 dB, and it dips 12 dB while you talk
- **Podcast**: voices only up front, everything else low
- **Even**: everything at the same level
Choose **Save current mix…** to keep your own.
**Ducking** automatically lowers Game, Clip and Music while a Voice input is talking, then fades them back up. Click the Ducking button to set how much and how sensitive. It affects both the recording and your headphones.

## Appearance
Settings → Appearance: **Liquid glass** (floating translucent panels with a soft glow from your main camera) or **Classic**.
**Reduce transparency** gives solid panels, easier to read and lighter on older computers. Explanations are hidden to keep things clean: hover a setting with a small dot to see its tip, or turn on **Show tips**. The app follows Windows light and dark mode.

## Preview layouts
Switch with the bar above the previews, or press L:
- **Grid**: every camera the same size
- **Spotlight**: the selected camera large, the rest as thumbnails (click one to swap)
- **Single**: one camera fills the whole area; use ‹ › to step through cameras
- **Output**: the live output large, cameras underneath; click one to put it on the output
Framing guides (rule of thirds, center, safe areas, 9:16 frame) are in the menu on the right of that bar.

## Camera presets
Click **Presets** next to a camera’s name to save its settings under a name (for example “Desk A-cam” or “Pulpit wide”) and apply them to any camera later.
Choose what a preset includes: image adjustments, framing, LUT, green screen, camera controls, resolution and frame rate, monitoring, file name.
Each camera also remembers its own settings: unplug it and add it again, and its name, look and settings come back.
Settings → Presets → Export saves every camera preset, look, audio preset and setup to one file; Import brings them in on another computer.

## File names
Settings → Project → File names → **Edit…** opens the name builder:
- Click pieces to add them: Project, Take, Camera, Date, Time, Setup, or your own text
- Use ‹ › to reorder and × to remove
- Pick what goes between pieces: underscore, dash, space or nothing
- Or tap a quick style, like “Date, project, camera”
The finished name shows live as you build it, for example `2026-11-11 Unboxing Desk Cam.mp4`.
To give one camera its own name, open its Camera tab → File name → **Customize…**. “Use the default name” switches it back.

## Shortcuts
Space record/stop · M marker · T teleprompter · L layout · 1–9 camera to output · Esc cancel countdown

## Rebuilding after changes
Source is in `src/`. Run `python3 build.py` to produce `dist/Gadget Cam Studio.html` and `electron/app/index.html`.

## AI voice cleanup (Windows app)
Each voice mic has an **AI voice cleanup** switch under Clean up. It uses RNNoise, a small neural network that removes fans, keyboards, hum and room noise while keeping your voice. It runs on the CPU and works with any mic: Lark, StudioLive, USB mics or a phone mic.
- It only shows on inputs whose role is **Voice**. Game, clip and music inputs can't use it.
- It's made for speech. Singing, worship music and instruments can sound watery through it, so leave it off for those.
- It's included in the Windows app build. The browser version shows the switch as "Windows app only".

## Animations
Panels, dialogs, tiles and layout changes animate smoothly. Faders glide when you switch mix presets. Strips glow while someone is talking and dim while they're ducked. The EQ shows your live voice behind the curve: grey is what comes in, and the color is what you hear. Turn animations off in Settings › Appearance; the app also follows the system's reduce motion setting.

## Audio per source
- **Audio in this file:** Each camera, video, image or screen can record the full mix, one mic on its own, or no audio. Set it in the camera's Camera tab. For example, give each person's camera their own lav.
- **Mic files:** Every audio input is also saved as its own 24-bit, 48 kHz WAV file, recorded after its effects but before the faders. The Resolve timeline puts each one on its own audio track, already lined up. Turn this off in Settings › Audio files & sync.
- **Sync beep:** One second into every take, a short beep goes into every file, so everything can be lined up by sound if needed. After each take the app also finds that beep in the video's own audio and uses it to line the mic files up in the Resolve timeline to within one frame, so keep the beep on if you use mic files.

## Backup copy
Settings › Backup copy writes a second copy of every file at the same time, ideally on another drive. If the backup drive fails, the main recording keeps going.

## Titles
Output panel › Titles adds lower thirds for names, scripture or topics. There are 4 styles, left or center placement, auto-hide, size and an accent color. Titles slide in and appear in the output recording, the output window and the virtual camera.

## Chapters
When you stop a take that has markers, you name them, and those names go into the Resolve markers. You also get a `_YouTube_chapters.txt` file to paste into the description. YouTube needs at least 3 chapters, each 10 seconds or longer.

## Phones
Settings › Phones has these options:
- Startup pairing on or off
- Ask before new phones join
- Remove phones you've allowed
- Make a new pairing code

A phone camera's Camera tab has remote controls for lens, quality, zoom, flashlight and phone mic.

## Auto-updates
The installed app checks GitHub Releases for updates. It downloads them in the background and installs them when you quit, or you can use Settings › Updates. To publish an update, push a version tag, for example `git tag v1.1.0 && git push --tags`. The workflow then builds the app and publishes the release. Updates need the repository to be **public**, because a private repo's releases can't be downloaded without a token.

## Camera transitions
Output panel › Picture › Transition sets how the output moves between cameras: Cut, Fade, Dip (through black), Slide or Zoom, with a speed from 0.15 to 1.5 seconds. Both cameras stay live during the move. Transitions appear in the output recording, the output window and the virtual camera. Each camera's own file is never affected.
