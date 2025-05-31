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

const toggleRecordingButton = document.getElementById('toggleRecording');
const downloadMidiButton = document.getElementById('downloadMidi');
const noteDisplay = document.getElementById('noteDisplay');
const frequencyDisplay = document.getElementById('frequencyDisplay');
const statusDisplay = document.getElementById('status');
const noteCountDisplay = document.getElementById('noteCount');

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const A4_FREQUENCY = 440;
const MIN_VALID_FREQUENCY = 80; // Increased minimum frequency
const MIN_AMPLITUDE_THRESHOLD = 30; // Increased threshold
const NOTE_DURATION_THRESHOLD = 100; // Minimum ms for a note to be recorded

toggleRecordingButton.addEventListener('click', () => {
    if (!isRecording) {
        startRecording();
    } else {
        stopRecording();
    }
});

downloadMidiButton.addEventListener('click', downloadMidiFile);

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

        analyser.fftSize = 8192; // Increased for better frequency resolution
        const bufferLength = analyser.frequencyBinCount;
        dataArray = new Float32Array(analyser.fftSize);
        frequencyData = new Uint8Array(bufferLength);

        sourceNode.connect(analyser);

        isRecording = true;
        recordedNotes = [];
        recordingStartTime = Date.now();
        lastDetectedNote = null;
        noteStartTime = null;
        toggleRecordingButton.textContent = 'Stop Recording';
        toggleRecordingButton.classList.add('recording');
        downloadMidiButton.disabled = true;
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

    // Finalize any ongoing note
    if (lastDetectedNote && noteStartTime) {
        const noteDuration = Date.now() - noteStartTime;
        if (noteDuration >= NOTE_DURATION_THRESHOLD) {
            recordedNotes.push({
                ...lastDetectedNote,
                duration: noteDuration,
                startTime: noteStartTime - recordingStartTime
            });
        }
    }

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

    // Get time domain data for autocorrelation
    analyser.getFloatTimeDomainData(dataArray);
    
    // Also get frequency data for amplitude check
    analyser.getByteFrequencyData(frequencyData);
    
    // Check if there's sufficient signal
    const maxAmplitude = Math.max(...frequencyData);
    if (maxAmplitude < MIN_AMPLITUDE_THRESHOLD) {
        handleNoteChange(null);
        frequencyDisplay.textContent = '-';
        noteDisplay.textContent = '-';
        return;
    }

    const frequency = detectPitchAutocorrelation(dataArray, audioContext.sampleRate);
    
    if (frequency && frequency >= MIN_VALID_FREQUENCY && frequency <= 2000) {
        frequencyDisplay.textContent = frequency.toFixed(2);
        const noteInfo = frequencyToNoteAndOctave(frequency);
        const noteString = noteInfo.name ? `${noteInfo.name}${noteInfo.octave}` : '-';
        noteDisplay.textContent = noteString;
        
        if (noteInfo.name) {
            handleNoteChange({
                note: noteInfo.name,
                octave: noteInfo.octave,
                frequency: frequency,
                midiNote: noteToMidi(noteInfo.name, noteInfo.octave)
            });
        } else {
            handleNoteChange(null);
        }
    } else {
        handleNoteChange(null);
        frequencyDisplay.textContent = '-';
        noteDisplay.textContent = '-';
    }
}

function detectPitchAutocorrelation(buffer, sampleRate) {
    const SIZE = buffer.length;
    const sumOfSquares = buffer.reduce((sum, val) => sum + val * val, 0);
    
    if (sumOfSquares < 0.001) return null; // Too quiet
    
    let bestOffset = -1;
    let bestCorrelation = 0;
    let rms = Math.sqrt(sumOfSquares / SIZE);
    
    if (rms < 0.01) return null; // Below noise threshold
    
    let lastCorrelation = 1;
    for (let offset = 10; offset < SIZE / 2; offset++) {
        let correlation = 0;
        
        for (let i = 0; i < SIZE - offset; i++) {
            correlation += Math.abs(buffer[i] - buffer[i + offset]);
        }
        correlation = 1 - (correlation / (SIZE - offset));
        
        if (correlation > 0.9 && correlation > lastCorrelation) {
            bestCorrelation = correlation;
            bestOffset = offset;
        } else if (correlation > 0.9 && bestCorrelation > 0.9) {
            break; // Found a good peak, stop looking
        }
        lastCorrelation = correlation;
    }
    
    if (bestCorrelation > 0.9 && bestOffset !== -1) {
        return sampleRate / bestOffset;
    }
    
    return null;
}

function handleNoteChange(currentNote) {
    const now = Date.now();
    const currentNoteString = currentNote ? `${currentNote.note}${currentNote.octave}` : null;
    const lastNoteString = lastDetectedNote ? `${lastDetectedNote.note}${lastDetectedNote.octave}` : null;
    
    if (currentNoteString !== lastNoteString) {
        // Note changed or stopped
        if (lastDetectedNote && noteStartTime) {
            const noteDuration = now - noteStartTime;
            if (noteDuration >= NOTE_DURATION_THRESHOLD) {
                const recordedNote = {
                    ...lastDetectedNote,
                    duration: noteDuration,
                    startTime: noteStartTime - recordingStartTime
                };
                recordedNotes.push(recordedNote);
                console.log('Recorded note:', recordedNote);
                noteCountDisplay.textContent = recordedNotes.length.toString();
            }
        }
        
        lastDetectedNote = currentNote;
        noteStartTime = currentNote ? now : null;
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
    
    // Simple MIDI file creation
    const ticksPerQuarter = 480;
    const microsecondsPerQuarter = 500000; // 120 BPM
    
    // MIDI header
    const header = new Uint8Array([
        0x4D, 0x54, 0x68, 0x64, // "MThd"
        0x00, 0x00, 0x00, 0x06, // Header length
        0x00, 0x00, // Format 0
        0x00, 0x01, // 1 track
        0x01, 0xE0  // Ticks per quarter note (480)
    ]);
    
    // Track events
    let trackData = [];
    
    // Add tempo event at time 0
    trackData.push(...[0x00, 0xFF, 0x51, 0x03]); // Delta time 0, Meta event, Set Tempo, length 3
    trackData.push(...[0x07, 0xA1, 0x20]); // 500000 microseconds per quarter note (120 BPM)
    
    // Sort notes by start time
    const sortedNotes = [...notes].sort((a, b) => a.startTime - b.startTime);
    
    let currentTick = 0;
    
    for (let i = 0; i < sortedNotes.length; i++) {
        const note = sortedNotes[i];
        
        // Convert milliseconds to ticks: (ms / 1000) * (ticks_per_quarter / (microseconds_per_quarter / 1000000))
        const startTick = Math.round((note.startTime / 1000) * (ticksPerQuarter / (microsecondsPerQuarter / 1000000)));
        const durationTicks = Math.max(24, Math.round((note.duration / 1000) * (ticksPerQuarter / (microsecondsPerQuarter / 1000000)))); // Minimum 24 ticks
        
        // Calculate delta time from current position to note start
        const deltaTimeStart = Math.max(0, startTick - currentTick);
        
        console.log(`Note ${i}: ${note.note}${note.octave}, startTime: ${note.startTime}ms, duration: ${note.duration}ms, startTick: ${startTick}, durationTicks: ${durationTicks}, deltaTime: ${deltaTimeStart}`);
        
        // Note on event
        trackData.push(...encodeVariableLength(deltaTimeStart));
        trackData.push(0x90); // Note on, channel 0
        trackData.push(note.midiNote); // Note number
        trackData.push(80); // Velocity
        
        // Note off event
        trackData.push(...encodeVariableLength(durationTicks));
        trackData.push(0x80); // Note off, channel 0
        trackData.push(note.midiNote); // Note number
        trackData.push(0); // Velocity 0
        
        currentTick = startTick + durationTicks;
    }
    
    // End of track
    trackData.push(0x00, 0xFF, 0x2F, 0x00);
    
    console.log('Track data length:', trackData.length);
    
    // Track header
    const trackHeader = new Uint8Array([
        0x4D, 0x54, 0x72, 0x6B, // "MTrk"
        ...intToBytes(trackData.length, 4) // Track length
    ]);
    
    // Combine all data
    const midiFile = new Uint8Array(header.length + trackHeader.length + trackData.length);
    midiFile.set(header, 0);
    midiFile.set(trackHeader, header.length);
    midiFile.set(trackData, header.length + trackHeader.length);
    
    console.log('MIDI file size:', midiFile.length, 'bytes');
    return midiFile;
}

function encodeVariableLength(value) {
    if (value < 0) value = 0; // Safety check
    if (value > 0x0FFFFFFF) value = 0x0FFFFFFF; // Safety check
    
    const bytes = [];
    bytes.unshift(value & 0x7F);
    value >>= 7;
    while (value) {
        bytes.unshift((value & 0x7F) | 0x80);
        value >>= 7;
    }
    return bytes;
}

function intToBytes(value, byteCount) {
    const bytes = [];
    for (let i = byteCount - 1; i >= 0; i--) {
        bytes.push((value >> (8 * i)) & 0xFF);
    }
    return bytes;
}

// Initial UI setup
statusDisplay.textContent = 'Status: Idle';
statusDisplay.className = 'status-idle';