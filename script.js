// Global variables
let audioContext;
let analyser;
let mediaStream;
let sourceNode;
let dataArray; // Uint8Array for frequency data
let animationFrameId;
let isRecording = false;

const toggleRecordingButton = document.getElementById('toggleRecording');
const noteDisplay = document.getElementById('noteDisplay');
const frequencyDisplay = document.getElementById('frequencyDisplay');
const statusDisplay = document.getElementById('status');
const sheetMusicJsonTextarea = document.getElementById('sheetMusicJson');
const downloadJsonButton = document.getElementById('downloadJsonButton');
const sheetMusicOutputContainer = document.getElementById('sheetMusicOutputContainer');

// Note detection constants
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const A4_FREQUENCY = 440;
const MIN_VALID_FREQUENCY = 20; // Minimum frequency to consider for note detection
const MIN_AMPLITUDE_THRESHOLD = 20; // Minimum amplitude (0-255) to consider a peak valid
const MIN_NOTE_DURATION_THRESHOLD = 0.05; // Minimum duration in seconds for a note to be recorded (50ms)

// New global variables for sheet music generation
let recordedSheetMusic = [];
let currentNoteStartTime = 0; // Timestamp for the start of the currently detected note segment
let lastDetectedNoteInfo = null; // Stores { name, octave } of the last processed note, or null
let recordingStartTime = 0; // performance.now() timestamp when recording actually begins processing audio

toggleRecordingButton.addEventListener('click', () => {
    if (!isRecording) {
        startRecording();
    } else {
        stopRecording();
    }
});

downloadJsonButton.addEventListener('click', () => {
    const jsonString = sheetMusicJsonTextarea.value;
    if (!jsonString || jsonString === 'No notes recorded.' || recordedSheetMusic.length === 0) {
        alert("No sheet music data to download. Record something first.");
        return;
    }
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `recorded_melody_${timestamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
});

async function startRecording() {
    if (isRecording) return;

    try {
        statusDisplay.textContent = 'Status: Requesting permissions...';
        mediaStream = await navigator.mediaDevices.getDisplayMedia({
            video: true, 
            audio: {
                // Optional: Add noise suppression, echo cancellation if needed,
                // but these can sometimes interfere with music.
                // noiseSuppression: true,
                // echoCancellation: true
            }
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

        analyser.fftSize = 4096; 
        // analyser.smoothingTimeConstant = 0.2; // Optional: smooths out readings, might delay note changes
        const bufferLength = analyser.frequencyBinCount;
        dataArray = new Uint8Array(bufferLength);

        sourceNode.connect(analyser);
        // Do not connect analyser to destination to avoid echo/feedback
        // analyser.connect(audioContext.destination); 

        isRecording = true;
        toggleRecordingButton.textContent = 'Stop Recording';
        toggleRecordingButton.classList.add('recording');
        statusDisplay.textContent = 'Status: Recording...';
        statusDisplay.className = 'status-recording';
        noteDisplay.textContent = '-';
        frequencyDisplay.textContent = '-';
        sheetMusicJsonTextarea.value = ''; // Clear previous JSON
        downloadJsonButton.disabled = true;
        sheetMusicOutputContainer.style.display = 'none';


        // Initialize sheet music recording variables
        recordedSheetMusic = [];
        lastDetectedNoteInfo = null;
        currentNoteStartTime = 0; 
        recordingStartTime = performance.now(); // Mark the actual start time for note timing

        analyzeAudio();

        mediaStream.getTracks().forEach(track => {
            track.onended = () => {
                console.log('Media stream track ended (e.g., user stopped sharing).');
                if (isRecording) { 
                    stopRecording();
                }
            };
        });

    } catch (err) {
        console.error("Error starting recording:", err);
        statusDisplay.textContent = `Error: ${err.name === 'NotAllowedError' ? 'Permission denied.' : err.message}`;
        statusDisplay.className = 'status-error';
        stopRecording(); 
    }
}

function stopRecording() {
    const wasActivelyRecording = isRecording; // Check if we were in a recording state
    
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    
    // Finalize the last note if one was being tracked
    if (wasActivelyRecording && recordingStartTime > 0 && lastDetectedNoteInfo && lastDetectedNoteInfo.name) {
        const currentTime = (performance.now() - recordingStartTime) / 1000.0;
        const duration = currentTime - currentNoteStartTime;
        if (duration >= MIN_NOTE_DURATION_THRESHOLD) {
            recordedSheetMusic.push({
                pitch: lastDetectedNoteInfo.name,
                octave: lastDetectedNoteInfo.octave,
                startTime: parseFloat(currentNoteStartTime.toFixed(3)),
                duration: parseFloat(duration.toFixed(3))
            });
        }
    }
    lastDetectedNoteInfo = null; // Reset for next recording session
    isRecording = false; // Set isRecording to false now

    stopMediaStream();

    if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
    }
    analyser = null; 
    
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(e => console.error("Error closing AudioContext:", e));
    }
    audioContext = null;
    
    dataArray = null;

    toggleRecordingButton.textContent = 'Start Recording';
    toggleRecordingButton.classList.remove('recording');
    
    if (statusDisplay.className !== 'status-error' || wasActivelyRecording) {
      statusDisplay.textContent = 'Status: Idle';
      statusDisplay.className = 'status-idle';
    }
    // Keep note/frequency display as is from last frame or clear them
    // noteDisplay.textContent = '-';
    // frequencyDisplay.textContent = '-';

    // Generate and display JSON
    if (recordedSheetMusic && recordedSheetMusic.length > 0) {
        const jsonString = generateSheetMusicJSON();
        sheetMusicJsonTextarea.value = jsonString;
        downloadJsonButton.disabled = false;
        sheetMusicOutputContainer.style.display = 'block';
    } else {
        sheetMusicJsonTextarea.value = 'No notes recorded.';
        downloadJsonButton.disabled = true;
        sheetMusicOutputContainer.style.display = 'block'; // Show container even if no notes, to display message
    }
    
    recordingStartTime = 0; // Reset recording start time

    if (wasActivelyRecording) console.log("Recording stopped. Notes recorded:", recordedSheetMusic.length);
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
    if (!isRecording || !analyser || !audioContext || !dataArray || recordingStartTime === 0) {
        if (isRecording && recordingStartTime === 0) { // Still waiting for recordingStartTime to be set
             animationFrameId = requestAnimationFrame(analyzeAudio);
        }
        return;
    }

    animationFrameId = requestAnimationFrame(analyzeAudio);
    analyser.getByteFrequencyData(dataArray);

    let maxAmplitude = 0;
    let dominantFrequencyBin = -1;

    for (let i = 0; i < dataArray.length; i++) {
        if (dataArray[i] > maxAmplitude) {
            maxAmplitude = dataArray[i];
            dominantFrequencyBin = i;
        }
    }
    
    const currentTime = (performance.now() - recordingStartTime) / 1000.0;
    let currentDetectedNote = null; // {name, octave} or null for this frame

    if (dominantFrequencyBin !== -1 && maxAmplitude > MIN_AMPLITUDE_THRESHOLD) {
        const binFrequency = dominantFrequencyBin * audioContext.sampleRate / analyser.fftSize;
        if (binFrequency >= MIN_VALID_FREQUENCY) {
            const noteInfo = frequencyToNoteAndOctave(binFrequency);
            if (noteInfo.name) {
                currentDetectedNote = noteInfo;
                frequencyDisplay.textContent = binFrequency.toFixed(2);
                noteDisplay.textContent = `${noteInfo.name}${noteInfo.octave}`;
            } else {
                frequencyDisplay.textContent = binFrequency.toFixed(2);
                noteDisplay.textContent = '-';
            }
        } else {
            frequencyDisplay.textContent = '-';
            noteDisplay.textContent = '-';
        }
    } else {
        frequencyDisplay.textContent = '-';
        noteDisplay.textContent = '-';
    }

    // Logic for recording notes for sheet music
    // Compare currentDetectedNote ({name, octave} or null) with lastDetectedNoteInfo ({name, octave} or null)
    const notesAreDifferent = 
        (!currentDetectedNote && lastDetectedNoteInfo) || // Note stopped
        (currentDetectedNote && !lastDetectedNoteInfo) || // Note started
        (currentDetectedNote && lastDetectedNoteInfo && // Note changed
         (currentDetectedNote.name !== lastDetectedNoteInfo.name || currentDetectedNote.octave !== lastDetectedNoteInfo.octave));

    if (notesAreDifferent) {
        // If a previous note was sounding and it has now changed or stopped
        if (lastDetectedNoteInfo && lastDetectedNoteInfo.name) {
            const duration = currentTime - currentNoteStartTime;
            if (duration >= MIN_NOTE_DURATION_THRESHOLD) {
                recordedSheetMusic.push({
                    pitch: lastDetectedNoteInfo.name,
                    octave: lastDetectedNoteInfo.octave,
                    startTime: parseFloat(currentNoteStartTime.toFixed(3)),
                    duration: parseFloat(duration.toFixed(3))
                });
            }
        }

        // If a new note is starting now
        if (currentDetectedNote && currentDetectedNote.name) {
            currentNoteStartTime = currentTime; // Mark the start time of this new note segment
        }
        // Update lastDetectedNoteInfo for the next frame
        lastDetectedNoteInfo = currentDetectedNote;
    }
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

function generateSheetMusicJSON() {
    const sheetMusicData = {
        title: "Recorded Melody",
        timeSignature: "4/4", // Placeholder, could be made configurable
        tempo: 120, // Placeholder, actual tempo is implicit in note timings
        notes: recordedSheetMusic
    };
    return JSON.stringify(sheetMusicData, null, 2); // Pretty print with 2 spaces
}

// Initial UI setup
statusDisplay.textContent = 'Status: Idle';
statusDisplay.className = 'status-idle';
sheetMusicOutputContainer.style.display = 'none'; // Hide JSON output area initially
downloadJsonButton.disabled = true; // Disable download button initially