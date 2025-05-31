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
let detectedLayers = new Map(); // Track different instrument layers
let layerClassifier = null;
let customLayerNames = new Map(); // Store custom layer names

// Essentia.js variables
let essentia = null;
let pitchDetector = null;
let onsetDetector = null;
let spectralFeatures = null;
let audioBuffer = [];
let frameSize = 2048;
let hopSize = 512;

const toggleRecordingButton = document.getElementById('toggleRecording');
const downloadMidiButton = document.getElementById('downloadMidi');
const downloadMp3Button = document.getElementById('downloadMp3');
const playbackButton = document.getElementById('playback');
const stopPlaybackButton = document.getElementById('stopPlayback');
const copyJsonButton = document.getElementById('copyJson');
const noteDisplay = document.getElementById('noteDisplay');
const frequencyDisplay = document.getElementById('frequencyDisplay');
const statusDisplay = document.getElementById('status');
const noteCountDisplay = document.getElementById('noteCount');

const sensitivitySlider = document.getElementById('sensitivitySlider');
const peakThresholdSlider = document.getElementById('peakThresholdSlider');
const noteDurationSlider = document.getElementById('noteDurationSlider');
const harmonicThresholdSlider = document.getElementById('harmonicThresholdSlider');
const onsetThresholdSlider = document.getElementById('onsetThresholdSlider');
const pitchConfidenceSlider = document.getElementById('pitchConfidenceSlider');

// Dynamic detection parameters
let MIN_AMPLITUDE_THRESHOLD = 20;
let PEAK_THRESHOLD = 30;
let NOTE_DURATION_THRESHOLD = 100;
let HARMONIC_THRESHOLD = 0.3;
let ONSET_THRESHOLD = 0.5;
let PITCH_CONFIDENCE_THRESHOLD = 0.7;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const A4_FREQUENCY = 440;
const MIN_VALID_FREQUENCY = 80; // Increased minimum frequency
const LAYER_PITCH_RANGES = {
    bass: { min: 40, max: 200, name: 'Bass' },
    lowMid: { min: 200, max: 500, name: 'Low Mid' },
    mid: { min: 500, max: 1000, name: 'Mid' },
    highMid: { min: 1000, max: 2000, name: 'High Mid' },
    treble: { min: 2000, max: 4000, name: 'Treble' }
};
const LAYER_PERSISTENCE_THRESHOLD = 3; // Minimum notes in a layer to consider it valid

toggleRecordingButton.addEventListener('click', () => {
    if (!isRecording) {
        startRecording();
    } else {
        stopRecording();
    }
});

sensitivitySlider.addEventListener('input', (e) => {
    MIN_AMPLITUDE_THRESHOLD = parseInt(e.target.value);
    document.getElementById('sensitivityValue').textContent = e.target.value;
});

peakThresholdSlider.addEventListener('input', (e) => {
    PEAK_THRESHOLD = parseInt(e.target.value);
    document.getElementById('peakThresholdValue').textContent = e.target.value;
});

noteDurationSlider.addEventListener('input', (e) => {
    NOTE_DURATION_THRESHOLD = parseInt(e.target.value);
    document.getElementById('noteDurationValue').textContent = e.target.value;
});

harmonicThresholdSlider.addEventListener('input', (e) => {
    HARMONIC_THRESHOLD = parseFloat(e.target.value);
    document.getElementById('harmonicThresholdValue').textContent = e.target.value;
});

onsetThresholdSlider.addEventListener('input', (e) => {
    ONSET_THRESHOLD = parseFloat(e.target.value);
    document.getElementById('onsetThresholdValue').textContent = e.target.value;
});

pitchConfidenceSlider.addEventListener('input', (e) => {
    PITCH_CONFIDENCE_THRESHOLD = parseFloat(e.target.value);
    document.getElementById('pitchConfidenceValue').textContent = e.target.value;
});

downloadMidiButton.addEventListener('click', downloadMidiFile);
downloadMp3Button.addEventListener('click', downloadMp3File);
playbackButton.addEventListener('click', playRecording);
stopPlaybackButton.addEventListener('click', stopPlayback);
copyJsonButton.addEventListener('click', copyJsonToClipboard);

async function startRecording() {
    if (isRecording) return;

    try {
        statusDisplay.textContent = 'Status: Initializing Essentia...';
        
        // Initialize Essentia.js properly
        if (!essentia) {
            // Load Essentia as a script since the module import isn't working
            if (!window.Essentia) {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.web.js';
                document.head.appendChild(script);
                
                await new Promise((resolve, reject) => {
                    script.onload = resolve;
                    script.onerror = reject;
                });
                
                // Wait a bit more for the library to initialize
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            if (window.Essentia) {
                essentia = new window.Essentia();
                await essentia.initialize();
            } else {
                console.warn('Essentia.js not available, using fallback detection');
                essentia = null;
            }
        }

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
        analyser.smoothingTimeConstant = 0.1; // Reduced for more responsive detection
        const bufferLength = analyser.frequencyBinCount;
        dataArray = new Float32Array(analyser.fftSize);
        frequencyData = new Uint8Array(bufferLength);

        sourceNode.connect(analyser);

        // Initialize audio buffer for Essentia processing
        audioBuffer = [];

        isRecording = true;
        recordedNotes = [];
        activeNotes.clear();
        detectedLayers.clear();
        recordingStartTime = Date.now();
        lastDetectedNote = null;
        noteStartTime = null;
        toggleRecordingButton.textContent = 'Stop Recording';
        toggleRecordingButton.classList.add('recording');
        downloadMidiButton.disabled = true;
        downloadMp3Button.disabled = true;
        copyJsonButton.disabled = true;
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
            const layer = classifyIntoLayer(noteData.noteInfo.frequency);
            const recordedNote = {
                ...noteData.noteInfo,
                duration: noteDuration,
                startTime: noteData.startTime - recordingStartTime,
                layer: layer.id,
                layerName: layer.name,
                confidence: noteData.noteInfo.confidence || 1,
                hasOnset: noteData.hasOnset || false
            };
            recordedNotes.push(recordedNote);
            updateLayerTracking(layer.id, recordedNote);
            console.log('Recorded note:', recordedNote);
            noteCountDisplay.textContent = recordedNotes.length.toString();
            updateLayerDisplay();
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
    copyJsonButton.disabled = recordedNotes.length === 0;
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
    if (!isRecording || !analyser || !audioContext || !dataArray || !essentia) return;

    animationFrameId = requestAnimationFrame(analyzeAudio);

    // Get time domain data for Essentia processing
    analyser.getFloatTimeDomainData(dataArray);
    analyser.getByteFrequencyData(frequencyData);
    
    // Add current frame to buffer
    const currentFrame = new Float32Array(dataArray);
    audioBuffer.push(currentFrame);
    
    // Keep buffer manageable (last 10 frames for onset detection)
    if (audioBuffer.length > 10) {
        audioBuffer.shift();
    }
    
    // Check if there's sufficient signal
    const maxAmplitude = Math.max(...frequencyData);
    if (maxAmplitude < MIN_AMPLITUDE_THRESHOLD) {
        handleNotesChange([]);
        frequencyDisplay.textContent = '-';
        noteDisplay.textContent = '-';
        return;
    }

    try {
        // Use Essentia for advanced analysis
        const analysisResults = performEssentiaAnalysis(currentFrame);
        
        if (analysisResults.detectedFrequencies.length > 0) {
            const freqDisplay = analysisResults.detectedFrequencies.map(f => f.toFixed(1)).join(', ');
            frequencyDisplay.textContent = freqDisplay;
            
            const noteInfos = analysisResults.detectedFrequencies.map(freq => {
                const noteInfo = frequencyToNoteAndOctave(freq);
                return {
                    ...noteInfo,
                    frequency: freq,
                    midiNote: noteToMidi(noteInfo.name, noteInfo.octave),
                    confidence: analysisResults.confidence || 1,
                    onset: analysisResults.hasOnset || false
                };
            }).filter(note => note.name && note.confidence >= PITCH_CONFIDENCE_THRESHOLD);
            
            const noteDisplayText = noteInfos.map(note => `${note.name}${note.octave}`).join(', ');
            document.getElementById('noteDisplay').textContent = noteDisplayText || '-';
            
            handleNotesChange(noteInfos, analysisResults.hasOnset);
        } else {
            // Fallback to original detection method
            const detectedFrequencies = detectMultipleFrequencies(frequencyData, audioContext.sampleRate);
            
            if (detectedFrequencies.length > 0) {
                const freqDisplay = detectedFrequencies.map(f => f.toFixed(1)).join(', ');
                frequencyDisplay.textContent = freqDisplay;
                
                const noteInfos = detectedFrequencies.map(freq => {
                    const noteInfo = frequencyToNoteAndOctave(freq);
                    return {
                        ...noteInfo,
                        frequency: freq,
                        midiNote: noteToMidi(noteInfo.name, noteInfo.octave),
                        confidence: 0.8,
                        onset: false
                    };
                }).filter(note => note.name);
                
                const noteDisplayText = noteInfos.map(note => `${note.name}${note.octave}`).join(', ');
                document.getElementById('noteDisplay').textContent = noteDisplayText || '-';
                
                handleNotesChange(noteInfos, false);
            } else {
                handleNotesChange([]);
                frequencyDisplay.textContent = '-';
                noteDisplay.textContent = '-';
            }
        }
    } catch (error) {
        console.warn('Essentia analysis failed, using fallback:', error);
        // Fallback to original method
        const detectedFrequencies = detectMultipleFrequencies(frequencyData, audioContext.sampleRate);
        
        if (detectedFrequencies.length > 0) {
            const freqDisplay = detectedFrequencies.map(f => f.toFixed(1)).join(', ');
            frequencyDisplay.textContent = freqDisplay;
            
            const noteInfos = detectedFrequencies.map(freq => {
                const noteInfo = frequencyToNoteAndOctave(freq);
                return {
                    ...noteInfo,
                    frequency: freq,
                    midiNote: noteToMidi(noteInfo.name, noteInfo.octave),
                    confidence: 0.8,
                    onset: false
                };
            }).filter(note => note.name);
            
            const noteDisplayText = noteInfos.map(note => `${note.name}${note.octave}`).join(', ');
            document.getElementById('noteDisplay').textContent = noteDisplayText || '-';
            
            handleNotesChange(noteInfos, false);
        } else {
            handleNotesChange([]);
            frequencyDisplay.textContent = '-';
            noteDisplay.textContent = '-';
        }
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

function performEssentiaAnalysis(audioFrame) {
    try {
        const results = {
            detectedFrequencies: [],
            confidence: 0,
            hasOnset: false,
            spectralFeatures: {}
        };

        // Pitch detection using Essentia
        const pitchResult = essentia.PitchYin(audioFrame, 80, 2000, 0.1);
        if (pitchResult.pitch > 80 && pitchResult.pitchConfidence >= PITCH_CONFIDENCE_THRESHOLD) {
            results.detectedFrequencies.push(pitchResult.pitch);
            results.confidence = pitchResult.pitchConfidence;
        }

        // Polyphonic pitch detection using spectral peaks
        const spectrum = essentia.Spectrum(audioFrame);
        const spectralPeaks = essentia.SpectralPeaks(spectrum.spectrum);
        
        // Filter and validate spectral peaks
        const validPeaks = spectralPeaks.frequencies
            .map((freq, i) => ({ freq, magnitude: spectralPeaks.magnitudes[i] }))
            .filter(peak => peak.freq >= 80 && peak.freq <= 2000 && peak.magnitude > PEAK_THRESHOLD)
            .sort((a, b) => b.magnitude - a.magnitude)
            .slice(0, 6); // Top 6 peaks

        // Add prominent peaks as additional frequencies
        validPeaks.forEach(peak => {
            if (!results.detectedFrequencies.some(f => Math.abs(f - peak.freq) < 5)) {
                results.detectedFrequencies.push(peak.freq);
            }
        });

        // Onset detection
        if (audioBuffer.length >= 2) {
            const prevFrame = audioBuffer[audioBuffer.length - 2];
            const currentFrame = audioBuffer[audioBuffer.length - 1];
            
            const prevSpectrum = essentia.Spectrum(prevFrame);
            const currentSpectrum = essentia.Spectrum(currentFrame);
            
            // Simple spectral flux for onset detection
            let spectralFlux = 0;
            for (let i = 0; i < Math.min(prevSpectrum.spectrum.length, currentSpectrum.spectrum.length); i++) {
                const diff = currentSpectrum.spectrum[i] - prevSpectrum.spectrum[i];
                if (diff > 0) spectralFlux += diff;
            }
            
            results.hasOnset = spectralFlux > ONSET_THRESHOLD;
        }

        // Harmonic analysis for better fundamental frequency detection
        if (results.detectedFrequencies.length > 1) {
            results.detectedFrequencies = filterHarmonics(results.detectedFrequencies);
        }

        return results;
    } catch (error) {
        console.warn('Essentia analysis error:', error);
        return { detectedFrequencies: [], confidence: 0, hasOnset: false };
    }
}

function filterHarmonics(frequencies) {
    const fundamentals = [];
    const sortedFreqs = frequencies.sort((a, b) => a - b);
    
    for (const freq of sortedFreqs) {
        let isFundamental = true;
        
        // Check if this frequency is a harmonic of existing fundamentals
        for (const fund of fundamentals) {
            const ratio = freq / fund;
            if (Math.abs(ratio - Math.round(ratio)) < 0.1 && ratio >= 1.5) {
                isFundamental = false;
                break;
            }
        }
        
        if (isFundamental) {
            fundamentals.push(freq);
        }
    }
    
    return fundamentals.slice(0, 4); // Max 4 simultaneous notes
}

function handleNotesChange(currentNotes, hasOnset = false) {
    const now = Date.now();
    const currentNoteKeys = new Set(currentNotes.map(note => `${note.name}${note.octave}`));
    const activeNoteKeys = new Set(activeNotes.keys());
    
    // End notes that are no longer detected
    for (const noteKey of activeNoteKeys) {
        if (!currentNoteKeys.has(noteKey)) {
            const noteData = activeNotes.get(noteKey);
            const noteDuration = now - noteData.startTime;
            if (noteDuration >= NOTE_DURATION_THRESHOLD) {
                const layer = classifyIntoLayer(noteData.noteInfo.frequency);
                const recordedNote = {
                    ...noteData.noteInfo,
                    duration: noteDuration,
                    startTime: noteData.startTime - recordingStartTime,
                    layer: layer.id,
                    layerName: layer.name,
                    confidence: noteData.noteInfo.confidence || 1,
                    hasOnset: noteData.hasOnset || false
                };
                recordedNotes.push(recordedNote);
                updateLayerTracking(layer.id, recordedNote);
                console.log('Recorded note:', recordedNote);
                noteCountDisplay.textContent = recordedNotes.length.toString();
                updateLayerDisplay();
            }
            activeNotes.delete(noteKey);
        }
    }
    
    // Start new notes
    for (const note of currentNotes) {
        const noteKey = `${note.name}${note.octave}`;
        if (!activeNotes.has(noteKey)) {
            activeNotes.set(noteKey, {
                noteInfo: note,
                startTime: now,
                hasOnset: hasOnset
            });
        }
    }
}

function classifyIntoLayer(frequency) {
    for (const [id, range] of Object.entries(LAYER_PITCH_RANGES)) {
        if (frequency >= range.min && frequency <= range.max) {
            return { id, name: range.name };
        }
    }
    return { id: 'other', name: 'Other' };
}

function updateLayerTracking(layerId, note) {
    if (!detectedLayers.has(layerId)) {
        detectedLayers.set(layerId, {
            notes: [],
            averageFreq: 0,
            lastActivity: Date.now()
        });
    }
    
    const layer = detectedLayers.get(layerId);
    layer.notes.push(note);
    layer.averageFreq = layer.notes.reduce((sum, n) => sum + n.frequency, 0) / layer.notes.length;
    layer.lastActivity = Date.now();
}

function updateLayerDisplay() {
    const validLayers = Array.from(detectedLayers.entries())
        .filter(([id, layer]) => layer.notes.length >= LAYER_PERSISTENCE_THRESHOLD);
    
    // Show/hide layer management section
    const layerManagement = document.getElementById('layerManagement');
    if (validLayers.length > 0) {
        layerManagement.style.display = 'block';
        
        const layerList = document.getElementById('layerList');
        layerList.innerHTML = '';
        
        validLayers.forEach(([id, layer]) => {
            const layerItem = document.createElement('div');
            layerItem.className = 'layer-item';
            
            const defaultName = LAYER_PITCH_RANGES[id]?.name || id;
            const customName = customLayerNames.get(id) || defaultName;
            
            layerItem.innerHTML = `
                <div class="layer-info">${defaultName}</div>
                <input type="text" class="layer-name-input" data-layer-id="${id}" 
                       value="${customName}" placeholder="Track name">
                <div class="layer-notes-count">${layer.notes.length} notes</div>
            `;
            
            layerList.appendChild(layerItem);
        });
        
        // Add event listeners for name inputs
        layerList.querySelectorAll('.layer-name-input').forEach(input => {
            input.addEventListener('input', (e) => {
                const layerId = e.target.dataset.layerId;
                const newName = e.target.value.trim();
                if (newName) {
                    customLayerNames.set(layerId, newName);
                } else {
                    customLayerNames.delete(layerId);
                }
            });
        });
    } else {
        layerManagement.style.display = 'none';
    }

    // Update the simple layer text display
    let layerText = validLayers.length > 0 
        ? validLayers.map(([id, layer]) => `${LAYER_PITCH_RANGES[id]?.name || id}: ${layer.notes.length}`).join(', ')
        : 'No layers detected';
    
    // Update or create layer display
    let layerDisplay = document.getElementById('layerDisplay');
    if (!layerDisplay) {
        layerDisplay = document.createElement('div');
        layerDisplay.id = 'layerDisplay';
        layerDisplay.innerHTML = '<p>Detected Layers: <span id="layerText">-</span></p>';
        document.getElementById('recordedNotes').insertAdjacentElement('afterend', layerDisplay);
    }
    document.getElementById('layerText').textContent = layerText;
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
    console.log('Processing notes for MIDI with enhanced timing:', notes);
    
    const ticksPerQuarter = 480;
    
    // Group notes by layer
    const layerGroups = {};
    notes.forEach(note => {
        const layerId = note.layer || 'default';
        if (!layerGroups[layerId]) {
            layerGroups[layerId] = [];
        }
        layerGroups[layerId].push(note);
    });
    
    // Sort notes by confidence and onset detection for better timing
    Object.values(layerGroups).forEach(layer => {
        layer.sort((a, b) => {
            if (a.startTime !== b.startTime) return a.startTime - b.startTime;
            if (a.hasOnset !== b.hasOnset) return b.hasOnset ? 1 : -1;
            return (b.confidence || 1) - (a.confidence || 1);
        });
    });
    
    const numTracks = Math.max(1, Object.keys(layerGroups).length);
    
    // MIDI header (Type 1 for multiple tracks, or Type 0 for single track)
    const header = new Uint8Array([
        0x4D, 0x54, 0x68, 0x64, // "MThd"
        0x00, 0x00, 0x00, 0x06, // Header length (6 bytes)
        numTracks > 1 ? 0x00 : 0x00, numTracks > 1 ? 0x01 : 0x00, // Format type
        (numTracks >> 8) & 0xFF, numTracks & 0xFF, // Number of tracks
        0x01, 0xE0  // Ticks per quarter note (480)
    ]);
    
    const allTracks = [];
    
    Object.entries(layerGroups).forEach(([layerId, layerNotes], trackIndex) => {
        let trackEvents = [];
        
        // Add track name and instrument
        if (numTracks > 1) {
            const defaultName = layerNotes[0]?.layerName || `Layer ${trackIndex + 1}`;
            const customName = customLayerNames.get(layerId) || defaultName;
            const trackName = customName;
            trackEvents.push(0x00, 0xFF, 0x03, trackName.length, ...Array.from(trackName).map(c => c.charCodeAt(0)));
            
            // Set instrument based on layer
            const instrument = getInstrumentForLayer(layerId);
            trackEvents.push(0x00, 0xC0 | trackIndex, instrument);
        }
        
        // Set tempo (only on first track)
        if (trackIndex === 0) {
            trackEvents.push(0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20);
        }
        
        const events = [];
        
        layerNotes.forEach(note => {
            const startTicks = Math.round((note.startTime / 1000) * (ticksPerQuarter * 2));
            const durationTicks = Math.max(ticksPerQuarter / 16, Math.round((note.duration / 1000) * (ticksPerQuarter * 2)));
            
            events.push({
                time: startTicks,
                type: 'noteOn',
                note: Math.max(0, Math.min(127, note.midiNote)),
                velocity: 80,
                channel: trackIndex % 16
            });
            
            events.push({
                time: startTicks + durationTicks,
                type: 'noteOff',
                note: Math.max(0, Math.min(127, note.midiNote)),
                velocity: 0,
                channel: trackIndex % 16
            });
        });
        
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
        allTracks.push(trackEvents);
    });
    
    // Combine header and all tracks
    let totalSize = header.length;
    const trackHeaders = allTracks.map(track => {
        const trackHeader = new Uint8Array([
            0x4D, 0x54, 0x72, 0x6B, // "MTrk"
            (track.length >> 24) & 0xFF,
            (track.length >> 16) & 0xFF,
            (track.length >> 8) & 0xFF,
            track.length & 0xFF
        ]);
        totalSize += trackHeader.length + track.length;
        return trackHeader;
    });
    
    const result = new Uint8Array(totalSize);
    let offset = 0;
    
    result.set(header, offset);
    offset += header.length;
    
    allTracks.forEach((track, index) => {
        result.set(trackHeaders[index], offset);
        offset += trackHeaders[index].length;
        result.set(track, offset);
        offset += track.length;
    });
    
    return result;
}

function getInstrumentForLayer(layerId) {
    const instrumentMap = {
        bass: 32, // Acoustic Bass
        lowMid: 33, // Electric Bass
        mid: 0, // Acoustic Grand Piano
        highMid: 40, // Violin
        treble: 73, // Flute
        other: 0 // Default Piano
    };
    return instrumentMap[layerId] || 0;
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

async function copyJsonToClipboard() {
    if (recordedNotes.length === 0) return;
    
    const jsonData = {
        recordingInfo: {
            totalNotes: recordedNotes.length,
            totalDuration: Math.max(...recordedNotes.map(note => note.startTime + note.duration)),
            timestamp: new Date().toISOString()
        },
        notes: recordedNotes.map(note => ({
            note: note.name,
            octave: note.octave,
            frequency: Math.round(note.frequency * 100) / 100,
            midiNote: note.midiNote,
            startTime: note.startTime,
            duration: note.duration,
            startTimeSeconds: Math.round(note.startTime / 10) / 100,
            durationSeconds: Math.round(note.duration / 10) / 100
        }))
    };
    
    try {
        await navigator.clipboard.writeText(JSON.stringify(jsonData, null, 2));
        
        // Visual feedback
        const originalText = copyJsonButton.textContent;
        copyJsonButton.textContent = 'Copied!';
        copyJsonButton.style.backgroundColor = '#28a745';
        
        setTimeout(() => {
            copyJsonButton.textContent = originalText;
            copyJsonButton.style.backgroundColor = '';
        }, 2000);
        
    } catch (err) {
        console.error('Failed to copy to clipboard:', err);
        alert('Failed to copy to clipboard. Please check browser permissions.');
    }
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