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

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const A4_FREQUENCY = 440;
const MIN_VALID_FREQUENCY = 20; // Minimum frequency to consider for note detection
const MIN_AMPLITUDE_THRESHOLD = 20; // Minimum amplitude (0-255) to consider a peak valid

toggleRecordingButton.addEventListener('click', () => {
    if (!isRecording) {
        startRecording();
    } else {
        stopRecording();
    }
});

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
            stopMediaStream(); // Clean up the partial mediaStream
            return;
        }

        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        sourceNode = audioContext.createMediaStreamSource(mediaStream);
        analyser = audioContext.createAnalyser();

        analyser.fftSize = 4096; 
        const bufferLength = analyser.frequencyBinCount;
        dataArray = new Uint8Array(bufferLength);

        sourceNode.connect(analyser);

        isRecording = true;
        toggleRecordingButton.textContent = 'Stop Recording';
        toggleRecordingButton.classList.add('recording');
        statusDisplay.textContent = 'Status: Recording...';
        statusDisplay.className = 'status-recording';
        noteDisplay.textContent = '-';
        frequencyDisplay.textContent = '-';

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
        // alert(`Could not start recording: ${err.message}. Make sure you grant permissions.`);
        stopRecording(); // Clean up any partial setup
    }
}

function stopRecording() {
    const wasRecording = isRecording; // Keep track if we were actually recording
    isRecording = false; 

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

    analyser.getByteFrequencyData(dataArray);

    let maxAmplitude = 0;
    let dominantFrequencyBin = -1;

    // Find the bin with the highest amplitude
    for (let i = 0; i < dataArray.length; i++) {
        if (dataArray[i] > maxAmplitude) {
            maxAmplitude = dataArray[i];
            dominantFrequencyBin = i;
        }
    }

    if (dominantFrequencyBin !== -1 && maxAmplitude > MIN_AMPLITUDE_THRESHOLD) {
        const binFrequency = dominantFrequencyBin * audioContext.sampleRate / analyser.fftSize;

        if (binFrequency >= MIN_VALID_FREQUENCY) {
            frequencyDisplay.textContent = binFrequency.toFixed(2);
            const noteInfo = frequencyToNoteAndOctave(binFrequency);
            noteDisplay.textContent = noteInfo.name ? `${noteInfo.name}${noteInfo.octave}` : '-';
        } else {
            frequencyDisplay.textContent = '-';
            noteDisplay.textContent = '-';
        }
    } else {
        frequencyDisplay.textContent = '-';
        noteDisplay.textContent = '-';
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

// Initial UI setup
statusDisplay.textContent = 'Status: Idle';
statusDisplay.className = 'status-idle';

