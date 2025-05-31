// Global variables
let audioContext;
let analyser;
let mediaStream;
let sourceNode;
let dataArray; // Float32Array for time domain data
let frequencyData; // Uint8Array for frequency data
let animationFrameId;
let isRecording = false;
let recordedNotes = [];
let lastDetectedNote = null;
let noteStartTime = null;
let recordingStartTime = null;
let playbackContext = null;
let playbackNodes = [];
let isPlaying = false;
let activeNotes = new Map(); // Track multiple simultaneous notes
let harmonicAnalyzer = null;

const toggleRecordingButton = document.getElementById('toggleRecording');
const downloadMidiButton = document.getElementById('downloadMidi');
const downloadMp3Button = document.getElementById('downloadMp3');
const playbackButton = document.getElementById('playback');
const stopPlaybackButton = document.getElementById('stopPlayback');
const noteDisplay = document.getElementById('noteDisplay');
const frequencyDisplay = document.getElementById('frequencyDisplay');
const statusDisplay = document.getElementById('status');
const noteCountDisplay = document.getElementById('noteCount');

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const A4_FREQUENCY = 440;
const MIN_VALID_FREQUENCY = 80; // Increased minimum frequency
const MIN_AMPLITUDE_THRESHOLD = 20; // Reduced for better sensitivity
const NOTE_DURATION_THRESHOLD = 100; // Minimum ms for a note to be recorded
const HARMONIC_THRESHOLD = 0.3; // Minimum ratio for harmonic detection
const PEAK_THRESHOLD = 30; // Minimum amplitude for frequency peaks

toggleRecordingButton.addEventListener('click', () => {
    if (!isRecording) {
        startRecording();
    } else {
        stopRecording();
    }
});

downloadMidiButton.addEventListener('click', downloadMidiFile);
downloadMp3Button.addEventListener('click', downloadMp3File);
playbackButton.addEventListener('click', playRecording);
stopPlaybackButton.addEventListener('click', stopPlayback);

async function startRecording() {
    if (isRecording) return;

    try {
        statusDisplay.textContent = 'Status: Requesting permissions...';
        mediaStream = await navigator.mediaDevices.getDisplayMedia({
            video: true, 
            audio: true,
        });

        if (!mediaStream.getAudioTracks().length) {
            alert("No audio track selected or available. Please ensure you select a source that includes audio (e.g., 'Share tab audio' if choosing a tab).");
            statusDisplay.textContent = 'Error: No audio track.';
            statusDisplay.className = 'status-error';
            stopMediaStream();
            return;
        }

        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        sourceNode = audioContext.createMediaStreamSource(mediaStream);
        analyser = audioContext.createAnalyser();

        analyser.fftSize = 16384; // Increased for better frequency resolution
        analyser.smoothingTimeConstant = 0.3; // Add smoothing
        const bufferLength = analyser.frequencyBinCount;
        dataArray = new Float32Array(analyser.fftSize);
        frequencyData = new Uint8Array(bufferLength);

        sourceNode.connect(analyser);

        isRecording = true;
        recordedNotes = [];
        activeNotes.clear();
        recordingStartTime = Date.now();
        lastDetectedNote = null;
        noteStartTime = null;
        toggleRecordingButton.textContent = 'Stop Recording';
        toggleRecordingButton.classList.add('recording');
        downloadMidiButton.disabled = true;
        downloadMp3Button.disabled = true;
        playbackButton.disabled = true;
        statusDisplay.textContent = 'Status: Recording...';
        statusDisplay.className = 'status-recording';
        noteDisplay.textContent = '-';
        frequencyDisplay.textContent = '-';
        noteCountDisplay.textContent = '0';

        analyzeAudio();

        mediaStream.getTracks().forEach(track => {
            track.onended = () => {
                console.log('Media stream track ended.');
                if (isRecording) { // If recording was active and stopped by browser UI
                    stopRecording();
                }
            };
        });

    } catch (err) {
        console.error("Error starting recording:", err);
        statusDisplay.textContent = `Error: ${err.name === 'NotAllowedError' ? 'Permission denied.' : err.message}`;
        statusDisplay.className = 'status-error';
        stopRecording(); // Clean up any partial setup
    }
}

function stopRecording() {
    const wasRecording = isRecording;
    isRecording = false; 

    // Finalize any ongoing notes
    for (const [noteKey, noteData] of activeNotes) {
        const noteDuration = Date.now() - noteData.startTime;
        if (noteDuration >= NOTE_DURATION_THRESHOLD) {
            recordedNotes.push({
                ...noteData.noteInfo,
                duration: noteDuration,
                startTime: noteData.startTime - recordingStartTime
            });
        }
    }
    activeNotes.clear();

    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }

    stopMediaStream();

    if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
    }
    // Analyser does not need explicit disconnect if source is disconnected and it's not connected to destination
    analyser = null; 
    
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(e => console.error("Error closing AudioContext:", e));
    }
    audioContext = null;
    
    dataArray = null;
    frequencyData = null;

    toggleRecordingButton.textContent = 'Start Recording';
    toggleRecordingButton.classList.remove('recording');
    
    // Only change status to Idle if it wasn't an error state or if it was actively stopped
    if (wasRecording || statusDisplay.className !== 'status-error') {
        statusDisplay.textContent = 'Status: Idle';
        statusDisplay.className = 'status-idle';
    }
    noteDisplay.textContent = '-';
    frequencyDisplay.textContent = '-';
    if (wasRecording) console.log("Recording stopped.");

    downloadMidiButton.disabled = recordedNotes.length === 0;
    downloadMp3Button.disabled = recordedNotes.length === 0;
    playbackButton.disabled = recordedNotes.length === 0;
    noteCountDisplay.textContent = recordedNotes.length.toString();
}

function stopMediaStream() {
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => {
            track.onended = null; // Important to remove listener before stopping
            track.stop();
        });
        mediaStream = null;
    }
}

function analyzeAudio() {
    if (!isRecording || !analyser || !audioContext || !dataArray) return;

    animationFrameId = requestAnimationFrame(analyzeAudio);

    // Get frequency domain data for polyphonic detection
    analyser.getByteFrequencyData(frequencyData);
    
    // Check if there's sufficient signal
    const maxAmplitude = Math.max(...frequencyData);
    if (maxAmplitude < MIN_AMPLITUDE_THRESHOLD) {
        handleNotesChange([]);
        frequencyDisplay.textContent = '-';
        noteDisplay.textContent = '-';
        return;
    }

    // Detect multiple frequencies using FFT peak detection
    const detectedFrequencies = detectMultipleFrequencies(frequencyData, audioContext.sampleRate);
    
    if (detectedFrequencies.length > 0) {
        const freqDisplay = detectedFrequencies.map(f => f.toFixed(1)).join(', ');
        frequencyDisplay.textContent = freqDisplay;
        
        const noteInfos = detectedFrequencies.map(freq => {
            const noteInfo = frequencyToNoteAndOctave(freq);
            return {
                ...noteInfo,
                frequency: freq,
                midiNote: noteToMidi(noteInfo.name, noteInfo.octave)
            };
        }).filter(note => note.name);
        
        const noteDisplay = noteInfos.map(note => `${note.name}${note.octave}`).join(', ');
        document.getElementById('noteDisplay').textContent = noteDisplay || '-';
        
        handleNotesChange(noteInfos);
    } else {
        handleNotesChange([]);
        frequencyDisplay.textContent = '-';
        noteDisplay.textContent = '-';
    }
}

function detectMultipleFrequencies(frequencyData, sampleRate) {
    const frequencies = [];
    const nyquist = sampleRate / 2;
    const binWidth = nyquist / frequencyData.length;
    
    // Find peaks in frequency spectrum
    const peaks = [];
    for (let i = 2; i < frequencyData.length - 2; i++) {
        const current = frequencyData[i];
        if (current > PEAK_THRESHOLD &&
            current > frequencyData[i - 1] &&
            current > frequencyData[i + 1] &&
            current > frequencyData[i - 2] &&
            current > frequencyData[i + 2]) {
            
            const frequency = i * binWidth;
            if (frequency >= MIN_VALID_FREQUENCY && frequency <= 2000) {
                peaks.push({ frequency, amplitude: current, bin: i });
            }
        }
    }
    
    // Sort peaks by amplitude
    peaks.sort((a, b) => b.amplitude - a.amplitude);
    
    // Filter out harmonics and keep only fundamental frequencies
    const fundamentals = [];
    for (const peak of peaks) {
        let isFundamental = true;
        
        // Check if this peak is a harmonic of any existing fundamental
        for (const fund of fundamentals) {
            const ratio = peak.frequency / fund.frequency;
            if (Math.abs(ratio - Math.round(ratio)) < 0.05 && ratio >= 2) {
                isFundamental = false;
                break;
            }
        }
        
        // Check if any existing fundamental is a harmonic of this peak
        if (isFundamental) {
            fundamentals.forEach((fund, index) => {
                const ratio = fund.frequency / peak.frequency;
                if (Math.abs(ratio - Math.round(ratio)) < 0.05 && ratio >= 2) {
                    fundamentals[index] = peak; // Replace with lower fundamental
                }
            });
        }
        
        if (isFundamental) {
            fundamentals.push(peak);
        }
        
        // Limit to top 4 simultaneous notes for performance
        if (fundamentals.length >= 4) break;
    }
    
    return fundamentals.map(peak => peak.frequency);
}

function handleNotesChange(currentNotes) {
    const now = Date.now();
    const currentNoteKeys = new Set(currentNotes.map(note => `${note.note}${note.octave}`));
    const activeNoteKeys = new Set(activeNotes.keys());
    
    // End notes that are no longer detected
    for (const noteKey of activeNoteKeys) {
        if (!currentNoteKeys.has(noteKey)) {
            const noteData = activeNotes.get(noteKey);
            const noteDuration = now - noteData.startTime;
            if (noteDuration >= NOTE_DURATION_THRESHOLD) {
                const recordedNote = {
                    ...noteData.noteInfo,
                    duration: noteDuration,
                    startTime: noteData.startTime - recordingStartTime
                };
                recordedNotes.push(recordedNote);
                console.log('Recorded note:', recordedNote);
                noteCountDisplay.textContent = recordedNotes.length.toString();
            }
            activeNotes.delete(noteKey);
        }
    }
    
    // Start new notes
    for (const note of currentNotes) {
        const noteKey = `${note.note}${note.octave}`;
        if (!activeNotes.has(noteKey)) {
            activeNotes.set(noteKey, {
                noteInfo: note,
                startTime: now
            });
        }
    }
}

function noteToMidi(noteName, octave) {
    const noteIndex = NOTE_NAMES.indexOf(noteName);
    return noteIndex + (octave + 1) * 12;
}

function frequencyToNoteAndOctave(frequency) {
    if (frequency < MIN_VALID_FREQUENCY) {
        return { name: null, octave: null };
    }
    // MIDI note number formula: m = 12 * log2(f/f_ref) + ref_note_midi
    // Using A4 = 440 Hz which is MIDI note 69
    const midiNote = 12 * (Math.log2(frequency / A4_FREQUENCY)) + 69;
    
    // Round to the nearest semitone
    const roundedMidiNote = Math.round(midiNote);

    // Ensure it's within standard MIDI range (0-127)
    if (roundedMidiNote < 0 || roundedMidiNote > 127) {
        return { name: null, octave: null };
    }

    const noteIndex = roundedMidiNote % 12;
    // MIDI note 0 is C-1. MIDI note 12 is C0. MIDI note 60 is C4.
    // Octave formula: floor(MIDI_note / 12) - 1
    const octave = Math.floor(roundedMidiNote / 12) - 1; 

    return {
        name: NOTE_NAMES[noteIndex],
        octave: octave
    };
}

function downloadMidiFile() {
    if (recordedNotes.length === 0) return;
    
    console.log('Creating MIDI file with notes:', recordedNotes);
    const midiData = createMidiFile(recordedNotes);
    const blob = new Blob([midiData], { type: 'audio/midi' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `recorded_notes_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.mid`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function createMidiFile(notes) {
    console.log('Processing notes for MIDI:', notes);
    
    const ticksPerQuarter = 480;
    
    // MIDI header (Type 0, 1 track, 480 ticks per quarter)
    const header = new Uint8Array([
        0x4D, 0x54, 0x68, 0x64, // "MThd"
        0x00, 0x00, 0x00, 0x06, // Header length (6 bytes)
        0x00, 0x00, // Format type 0
        0x00, 0x01, // Number of tracks (1)
        0x01, 0xE0  // Ticks per quarter note (480)
    ]);
    
    let trackEvents = [];
    
    // Set tempo: 120 BPM (500000 microseconds per quarter note)
    trackEvents.push(0x00); // Delta time
    trackEvents.push(0xFF, 0x51, 0x03); // Meta event: Set Tempo
    trackEvents.push(0x07, 0xA1, 0x20); // 500000 microseconds
    
    // Group overlapping notes to handle polyphony
    const events = [];
    
    notes.forEach(note => {
        const startTicks = Math.round((note.startTime / 1000) * (ticksPerQuarter * 2));
        const durationTicks = Math.max(ticksPerQuarter / 16, Math.round((note.duration / 1000) * (ticksPerQuarter * 2)));
        
        events.push({
            time: startTicks,
            type: 'noteOn',
            note: Math.max(0, Math.min(127, note.midiNote)),
            velocity: 80,
            channel: 0
        });
        
        events.push({
            time: startTicks + durationTicks,
            type: 'noteOff',
            note: Math.max(0, Math.min(127, note.midiNote)),
            velocity: 0,
            channel: 0
        });
    });
    
    // Sort all events by time, then by type (noteOff before noteOn for same time)
    events.sort((a, b) => {
        if (a.time !== b.time) return a.time - b.time;
        if (a.type === 'noteOff' && b.type === 'noteOn') return -1;
        if (a.type === 'noteOn' && b.type === 'noteOff') return 1;
        return 0;
    });
    
    let currentTime = 0;
    events.forEach(event => {
        const deltaTime = Math.max(0, event.time - currentTime);
        trackEvents.push(...writeVariableLength(deltaTime));
        
        if (event.type === 'noteOn') {
            trackEvents.push(0x90 | event.channel, event.note, event.velocity);
        } else {
            trackEvents.push(0x80 | event.channel, event.note, event.velocity);
        }
        
        currentTime = event.time;
    });
    
    // End of track
    trackEvents.push(0x00, 0xFF, 0x2F, 0x00);
    
    // Track header
    const trackHeader = new Uint8Array([
        0x4D, 0x54, 0x72, 0x6B, // "MTrk"
        (trackEvents.length >> 24) & 0xFF,
        (trackEvents.length >> 16) & 0xFF,
        (trackEvents.length >> 8) & 0xFF,
        trackEvents.length & 0xFF
    ]);
    
    // Combine everything
    const result = new Uint8Array(header.length + trackHeader.length + trackEvents.length);
    result.set(header, 0);
    result.set(trackHeader, header.length);
    result.set(trackEvents, header.length + trackHeader.length);
    
    return result;
}

function writeVariableLength(value) {
    const bytes = [];
    bytes.unshift(value & 0x7F);
    value >>= 7;
    while (value > 0) {
        bytes.unshift((value & 0x7F) | 0x80);
        value >>= 7;
    }
    return bytes;
}

function encodeVariableLength(value) {
    return writeVariableLength(value);
}

async function downloadMp3File() {
    if (recordedNotes.length === 0) return;
    
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const sampleRate = audioCtx.sampleRate;
    const totalDuration = Math.max(...recordedNotes.map(note => note.startTime + note.duration)) / 1000;
    const length = Math.ceil(totalDuration * sampleRate);
    const audioBuffer = audioCtx.createBuffer(2, length, sampleRate); // Stereo
    const leftChannel = audioBuffer.getChannelData(0);
    const rightChannel = audioBuffer.getChannelData(1);
    
    // Generate audio for each note with better synthesis
    recordedNotes.forEach(note => {
        const startSample = Math.floor((note.startTime / 1000) * sampleRate);
        const durationSamples = Math.floor((note.duration / 1000) * sampleRate);
        const frequency = note.frequency;
        
        for (let i = 0; i < durationSamples && (startSample + i) < length; i++) {
            const time = i / sampleRate;
            // Better envelope with attack, decay, sustain, release
            let envelope = 1;
            const attackTime = 0.1;
            const decayTime = 0.2;
            const sustainLevel = 0.7;
            const releaseTime = 0.3;
            const noteDuration = durationSamples / sampleRate;
            
            if (time < attackTime) {
                envelope = time / attackTime;
            } else if (time < attackTime + decayTime) {
                envelope = 1 - (1 - sustainLevel) * (time - attackTime) / decayTime;
            } else if (time < noteDuration - releaseTime) {
                envelope = sustainLevel;
            } else {
                envelope = sustainLevel * (noteDuration - time) / releaseTime;
            }
            
            // Add some harmonics for richer sound
            const fundamental = Math.sin(2 * Math.PI * frequency * time);
            const harmonic2 = Math.sin(2 * Math.PI * frequency * 2 * time) * 0.3;
            const harmonic3 = Math.sin(2 * Math.PI * frequency * 3 * time) * 0.1;
            
            const sample = (fundamental + harmonic2 + harmonic3) * envelope * 0.2;
            
            if (startSample + i < leftChannel.length) {
                leftChannel[startSample + i] += sample;
                rightChannel[startSample + i] += sample;
            }
        }
    });
    
    // Convert to WAV format (simplified MP3 alternative)
    const wavData = audioBufferToWav(audioBuffer);
    const blob = new Blob([wavData], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `recorded_notes_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    await audioCtx.close();
}

function audioBufferToWav(buffer) {
    const length = buffer.length;
    const sampleRate = buffer.sampleRate;
    const arrayBuffer = new ArrayBuffer(44 + length * 2 * 2);
    const view = new DataView(arrayBuffer);
    const leftChannel = buffer.getChannelData(0);
    const rightChannel = buffer.getChannelData(1);
    
    // WAV header
    const writeString = (offset, string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };
    
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + length * 2 * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2 * 2, true);
    view.setUint16(32, 2 * 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, length * 2 * 2, true);
    
    // Convert float samples to 16-bit PCM
    let offset = 44;
    for (let i = 0; i < length; i++) {
        const leftSample = Math.max(-1, Math.min(1, leftChannel[i]));
        const rightSample = Math.max(-1, Math.min(1, rightChannel[i]));
        view.setInt16(offset, leftSample * 0x7FFF, true);
        offset += 2;
        view.setInt16(offset, rightSample * 0x7FFF, true);
        offset += 2;
    }
    
    return arrayBuffer;
}

async function playRecording() {
    if (recordedNotes.length === 0 || isPlaying) return;
    
    isPlaying = true;
    playbackButton.disabled = true;
    stopPlaybackButton.disabled = false;
    
    try {
        playbackContext = new (window.AudioContext || window.webkitAudioContext)();
        
        recordedNotes.forEach(note => {
            const oscillator = playbackContext.createOscillator();
            const gainNode = playbackContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(playbackContext.destination);
            
            oscillator.frequency.setValueAtTime(note.frequency, playbackContext.currentTime);
            oscillator.type = 'sine';
            
            const startTime = playbackContext.currentTime + (note.startTime / 1000);
            const endTime = startTime + (note.duration / 1000);
            
            gainNode.gain.setValueAtTime(0, playbackContext.currentTime);
            gainNode.gain.setValueAtTime(0.3, startTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, endTime);
            
            oscillator.start(startTime);
            oscillator.stop(endTime);
            
            playbackNodes.push({ oscillator, gainNode });
        });
        
        // Auto-stop when done
        const totalDuration = Math.max(...recordedNotes.map(note => note.startTime + note.duration));
        setTimeout(() => {
            if (isPlaying) stopPlayback();
        }, totalDuration + 1000);
        
    } catch (error) {
        console.error('Playback error:', error);
        stopPlayback();
    }
}

function stopPlayback() {
    if (!isPlaying) return;
    
    isPlaying = false;
    playbackButton.disabled = false;
    stopPlaybackButton.disabled = true;
    
    playbackNodes.forEach(({ oscillator, gainNode }) => {
        try {
            oscillator.stop();
            oscillator.disconnect();
            gainNode.disconnect();
        } catch (e) {
            // Ignore errors from already stopped nodes
        }
    });
    playbackNodes = [];
    
    if (playbackContext) {
        playbackContext.close().catch(e => console.error('Error closing playback context:', e));
        playbackContext = null;
    }
}

// Initial UI setup
statusDisplay.textContent = 'Status: Idle';
statusDisplay.className = 'status-idle';