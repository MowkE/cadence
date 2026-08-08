#!/usr/bin/env python3
"""
Spotify Client for Electron Integration

This script handles Spotify authentication and data retrieval.
It's called from the Electron main process and outputs JSON to stdout.

Usage:
    python spotify_client.py --action get_track
    python spotify_client.py --action get_lyrics --track_name "..." --artist_name "..." --album_name "..." --duration "..."
"""

import os
import sys
import json
import re
import argparse
import requests
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from dotenv import load_dotenv
import appdirs
import pathlib

# Load environment variables
load_dotenv()

# ============================================================================
# CONFIGURATION
# ============================================================================
SPOTIFY_CLIENT_ID = os.getenv('SPOTIFY_CLIENT_ID')
SPOTIFY_CLIENT_SECRET = os.getenv('SPOTIFY_CLIENT_SECRET')
REDIRECT_URI = "http://127.0.0.1:8888/callback"
SCOPE = "user-read-currently-playing user-read-playback-state user-modify-playback-state"

# LRCLIB API (free, no auth required)
LRCLIB_API_URL = "https://lrclib.net/api/get"

# Cache directory for tokens
APP_NAME = "LyricsOverlay"
APP_AUTHOR = "LyricsOverlay"


def get_cache_path():
    """Get the cache path for Spotify tokens."""
    cache_dir = appdirs.user_cache_dir(APP_NAME, APP_AUTHOR)
    pathlib.Path(cache_dir).mkdir(parents=True, exist_ok=True)
    return os.path.join(cache_dir, '.spotify_cache')


def get_auth_manager():
    """Get the Spotify OAuth manager."""
    if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
        raise ValueError("Spotify credentials not found. Please set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET")
    
    return SpotifyOAuth(
        client_id=SPOTIFY_CLIENT_ID,
        client_secret=SPOTIFY_CLIENT_SECRET,
        redirect_uri=REDIRECT_URI,
        scope=SCOPE,
        cache_path=get_cache_path(),
        open_browser=True
    )


def get_spotify_client():
    """Initialize and return the Spotify client."""
    auth_manager = get_auth_manager()
    return spotipy.Spotify(auth_manager=auth_manager)


def refresh_token():
    """Force refresh the Spotify access token."""
    try:
        auth_manager = get_auth_manager()
        token_info = auth_manager.cache_handler.get_cached_token()
        
        if token_info:
            # Force refresh the token
            if auth_manager.is_token_expired(token_info):
                token_info = auth_manager.refresh_access_token(token_info['refresh_token'])
            else:
                # Even if not expired, force refresh to extend validity
                token_info = auth_manager.refresh_access_token(token_info['refresh_token'])
            
            return {
                'success': True,
                'message': 'Token refreshed successfully',
                'expires_at': token_info.get('expires_at')
            }
        else:
            # No cached token, need full auth
            return {
                'success': False,
                'error': 'No cached token found. Full authentication required.',
                'needs_auth': True
            }
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'needs_auth': True
        }


def control_playback(sp, command, position=None):
    """Control Spotify playback: play, pause, next, previous, seek."""
    try:
        if command == 'play':
            sp.start_playback()
        elif command == 'pause':
            sp.pause_playback()
        elif command == 'next':
            sp.next_track()
        elif command == 'previous':
            sp.previous_track()
        elif command == 'seek':
            sp.seek_track(int(float(position or 0)))
        else:
            return {'success': False, 'error': f'Unknown command: {command}'}
        return {'success': True, 'command': command}
    except spotipy.SpotifyException as e:
        return {
            'success': False,
            'error': str(e),
            'error_code': e.http_status if hasattr(e, 'http_status') else None
        }


def get_current_track(sp):
    """Get the currently playing track information."""
    try:
        current = sp.current_user_playing_track()

        # Report paused tracks too (is_playing False) so the overlay can
        # keep the display and detect pause/resume itself
        if current and current.get('item'):
            track = current.get('item')
            if track:
                # Get album art (largest available)
                images = track['album'].get('images', [])
                album_art = images[0]['url'] if images else None
                
                return {
                    'success': True,
                    'track': {
                        'id': track['id'],
                        'name': track['name'],
                        'artist': ', '.join([artist['name'] for artist in track['artists']]),
                        'artists': [artist['name'] for artist in track['artists']],
                        'album': track['album']['name'],
                        'album_art': album_art,
                        'duration_ms': track['duration_ms'],
                        'progress_ms': current['progress_ms'],
                        'is_playing': current['is_playing']
                    }
                }
        
        return {
            'success': True,
            'track': None,
            'message': 'No track currently playing'
        }
        
    except spotipy.SpotifyException as e:
        return {
            'success': False,
            'error': str(e),
            'error_code': e.http_status if hasattr(e, 'http_status') else None
        }
    except Exception as e:
        return {
            'success': False,
            'error': str(e)
        }


def parse_lrc(lrc_text):
    """Parse LRC format lyrics into a list of dictionaries with timestamps."""
    lyrics = []
    for line in lrc_text.splitlines():
        # Match [mm:ss.xx] or [mm:ss.xxx] format
        match = re.match(r'\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)', line)
        if match:
            minutes, seconds, milliseconds, text = match.groups()
            # Handle both 2-digit and 3-digit milliseconds
            if len(milliseconds) == 2:
                milliseconds = int(milliseconds) * 10
            else:
                milliseconds = int(milliseconds)
            time_ms = int(minutes) * 60000 + int(seconds) * 1000 + milliseconds
            if text.strip():  # Only add non-empty lines
                lyrics.append({
                    'startTimeMs': time_ms,
                    'text': text.strip()
                })
    return lyrics


def get_synced_lyrics(track_name, artist_name, album_name, duration_seconds):
    """Get synced lyrics from LRCLIB (free API, no auth required)."""
    try:
        params = {
            'track_name': track_name,
            'artist_name': artist_name,
            'album_name': album_name,
            'duration': int(duration_seconds)
        }
        
        response = requests.get(LRCLIB_API_URL, params=params, timeout=10)
        
        if response.status_code == 404:
            # Try without album name
            params_no_album = {
                'track_name': track_name,
                'artist_name': artist_name,
                'duration': int(duration_seconds)
            }
            response = requests.get(LRCLIB_API_URL, params=params_no_album, timeout=10)
        
        if response.status_code != 200:
            return {
                'success': False,
                'error': f'LRCLIB returned status {response.status_code}',
                'lines': []
            }
        
        data = response.json()
        
        # Check for synced lyrics first
        if data and data.get('syncedLyrics'):
            lines = parse_lrc(data['syncedLyrics'])
            if lines:
                return {
                    'success': True,
                    'synced': True,
                    'syncType': 'LINE_SYNCED',
                    'lines': lines,
                    'source': 'lrclib'
                }
        
        # Fall back to plain lyrics (unsynced)
        if data and data.get('plainLyrics'):
            plain_lines = [
                {'text': line.strip(), 'startTimeMs': None}
                for line in data['plainLyrics'].split('\n')
                if line.strip()
            ]
            return {
                'success': True,
                'synced': False,
                'syncType': 'UNSYNCED',
                'lines': plain_lines,
                'source': 'lrclib'
            }
        
        return {
            'success': False,
            'error': 'No lyrics found in LRCLIB response',
            'lines': []
        }
        
    except requests.exceptions.Timeout:
        return {
            'success': False,
            'error': 'LRCLIB request timed out',
            'lines': []
        }
    except requests.exceptions.RequestException as e:
        return {
            'success': False,
            'error': f'LRCLIB request failed: {str(e)}',
            'lines': []
        }
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'lines': []
        }


def get_audio_analysis(sp, track_id):
    """Get audio analysis (beats, tempo) for a track."""
    try:
        analysis = sp.audio_analysis(track_id)
        features = sp.audio_features([track_id])
        
        if analysis:
            # Extract beat information
            beats = []
            for beat in analysis.get('beats', []):
                beats.append({
                    'start': beat['start'],
                    'duration': beat['duration'],
                    'confidence': beat['confidence']
                })
            
            # Extract section information for song structure
            sections = []
            for section in analysis.get('sections', []):
                sections.append({
                    'start': section['start'],
                    'duration': section['duration'],
                    'loudness': section['loudness'],
                    'tempo': section['tempo']
                })
            
            # Get tempo from audio features
            tempo = features[0]['tempo'] if features and features[0] else 120
            energy = features[0]['energy'] if features and features[0] else 0.5
            
            return {
                'success': True,
                'analysis': {
                    'track_id': track_id,
                    'tempo': tempo,
                    'energy': energy,
                    'beats': beats[:500],  # Limit to first 500 beats for performance
                    'sections': sections,
                    'total_beats': len(analysis.get('beats', []))
                }
            }
        
        return {
            'success': True,
            'analysis': None,
            'message': 'No analysis available'
        }
        
    except spotipy.SpotifyException as e:
        return {
            'success': False,
            'error': str(e),
            'error_code': e.http_status if hasattr(e, 'http_status') else None
        }
    except Exception as e:
        return {
            'success': False,
            'error': str(e)
        }


def main():
    parser = argparse.ArgumentParser(description='Spotify Client for Lyrics Overlay')
    parser.add_argument('--action', required=True,
                        choices=['get_track', 'get_lyrics', 'get_analysis', 'refresh_token', 'control'],
                        help='Action to perform')
    parser.add_argument('--command', help='Playback command: play, pause, next, previous, seek')
    parser.add_argument('--position', help='Seek position in ms')
    parser.add_argument('--track_name', help='Track name for lyrics')
    parser.add_argument('--artist_name', help='Artist name for lyrics')
    parser.add_argument('--album_name', help='Album name for lyrics')
    parser.add_argument('--duration', help='Track duration in seconds for lyrics')
    parser.add_argument('--track_id', help='Track ID for audio analysis')
    
    args = parser.parse_args()
    
    try:
        if args.action == 'get_track':
            sp = get_spotify_client()
            result = get_current_track(sp)
        elif args.action == 'get_lyrics':
            if not args.track_name or not args.artist_name:
                result = {'success': False, 'error': 'track_name and artist_name required for lyrics'}
            else:
                duration = float(args.duration) if args.duration else 0
                result = get_synced_lyrics(
                    args.track_name,
                    args.artist_name,
                    args.album_name or '',
                    duration
                )
        elif args.action == 'get_analysis':
            if not args.track_id:
                result = {'success': False, 'error': 'track_id required for analysis'}
            else:
                sp = get_spotify_client()
                result = get_audio_analysis(sp, args.track_id)
        elif args.action == 'refresh_token':
            result = refresh_token()
        elif args.action == 'control':
            sp = get_spotify_client()
            result = control_playback(sp, args.command, args.position)
        elif args.action == 'clear_cache':
            cache = get_cache_path()
            if os.path.exists(cache):
                os.remove(cache)
            result = {'success': True}
        else:
            result = {'success': False, 'error': f'Unknown action: {args.action}'}
        
        # Output JSON to stdout for Node.js to capture
        print(json.dumps(result))
        
    except Exception as e:
        error_result = {
            'success': False,
            'error': str(e)
        }
        print(json.dumps(error_result))
        sys.exit(1)


if __name__ == '__main__':
    main()

