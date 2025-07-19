const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Function to extract video ID from YouTube URL
function extractVideoId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/.*[?&]v=)([^"&?\/\s]{11})/,
        /^([a-zA-Z0-9_-]{11})$/ // Direct video ID
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
            return match[1];
        }
    }
    
    return null;
}

// Parse transcript XML
function parseTranscriptXML(xmlData) {
    try {
        const transcript = [];
        const patterns = [
            /<text start="([^"]+)"[^>]*dur="([^"]+)"[^>]*>([^<]*)<\/text>/g,
            /<text start="([^"]+)"[^>]*duration="([^"]+)"[^>]*>([^<]*)<\/text>/g,
            /<text start="([^"]+)"[^>]*>([^<]*)<\/text>/g,
            /<text start="([^"]+)"[^>]*d="([^"]+)"[^>]*>([^<]*)<\/text>/g,
            /<text[^>]*start="([^"]+)"[^>]*>([^<]*)<\/text>/g
        ];

        let foundMatches = false;
        
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(xmlData)) !== null) {
                foundMatches = true;
                const start = parseFloat(match[1]);
                const duration = match[2] ? parseFloat(match[2]) : 3.0;
                const text = match[match.length - 1]
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .replace(/&apos;/g, "'")
                    .replace(/&#x27;/g, "'")
                    .replace(/&#x2F;/g, '/')
                    .replace(/&#x3C;/g, '<')
                    .replace(/&#x3E;/g, '>');
                
                if (text.trim()) {
                    transcript.push({
                        text: text.trim(),
                        offset: start,
                        duration: duration
                    });
                }
            }
            
            if (foundMatches) break;
        }
        
        if (!foundMatches) {
            const textMatches = xmlData.match(/<text[^>]*>([^<]*)<\/text>/g);
            if (textMatches && textMatches.length > 0) {
                textMatches.forEach((match, index) => {
                    const textContent = match.replace(/<text[^>]*>([^<]*)<\/text>/, '$1')
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'")
                        .replace(/&apos;/g, "'");
                    
                    if (textContent.trim()) {
                        transcript.push({
                            text: textContent.trim(),
                            offset: index * 3.0,
                            duration: 3.0
                        });
                    }
                });
                foundMatches = transcript.length > 0;
            }
        }
        
        if (!foundMatches) {
            throw new Error('No transcript entries found in XML');
        }
        
        return transcript;
    } catch (error) {
        throw new Error(`Failed to parse transcript XML: ${error.message}`);
    }
}

// Method 1: Primary method using YouTube's innertube API
async function fetchTranscriptMethod1(videoId, lang = 'en') {
    const innertubeUrl = 'https://www.youtube.com/youtubei/v1/player';
    const response = await axios.post(innertubeUrl, {
        context: {
            client: {
                clientName: 'WEB',
                clientVersion: '2.20250710.09.00',
                hl: 'en',
                gl: 'US'
            }
        },
        videoId: videoId
    }, {
        timeout: 20000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://www.youtube.com',
            'Referer': `https://www.youtube.com/watch?v=${videoId}`,
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache'
        }
    });
    
    const data = response.data;
    
    // Check if we got a valid response
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid response from YouTube API');
    }
    
    // Check for error responses
    if (data.error || data.playabilityStatus?.status === 'ERROR') {
        throw new Error(`YouTube API error: ${data.error?.message || data.playabilityStatus?.reason || 'Unknown error'}`);
    }
    
    const captions = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captions || captions.length === 0) {
        // Check if this is due to blocking or actual no captions
        if (data.videoDetails && data.videoDetails.length > 0) {
            throw new Error('No captions found for this video');
        } else {
            throw new Error('YouTube may be blocking requests from this IP');
        }
    }
    
    let selectedCaption = captions.find(track => track.languageCode === lang);
    
    if (!selectedCaption) {
        selectedCaption = captions.find(track => 
            track.languageCode === 'auto' && track.name?.simpleText?.includes(lang)
        );
    }
    
    if (!selectedCaption) {
        selectedCaption = captions.find(track => 
            track.languageCode.startsWith(lang.split('-')[0])
        );
    }
    
    if (!selectedCaption) {
        selectedCaption = captions[0];
    }
    
    if (!selectedCaption || !selectedCaption.baseUrl) {
        throw new Error('No valid caption URL found');
    }
    
    const transcriptResponse = await axios.get(selectedCaption.baseUrl, {
        timeout: 15000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/xml, text/xml, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive'
        }
    });
    
    if (!transcriptResponse.data) {
        throw new Error('Empty transcript response');
    }
    
    const transcript = parseTranscriptXML(transcriptResponse.data);
    if (!transcript || transcript.length === 0) {
        throw new Error('No transcript content found after parsing');
    }
    
    return {
        transcript,
        language: selectedCaption.languageCode,
        availableLanguages: captions.map(track => ({
            code: track.languageCode,
            name: track.name?.simpleText || track.languageCode
        }))
    };
}

// Method 2: Alternative method using different user agent and approach
async function fetchTranscriptMethod2(videoId, lang = 'en') {
    const innertubeUrl = 'https://www.youtube.com/youtubei/v1/player';
    const response = await axios.post(innertubeUrl, {
        context: {
            client: {
                clientName: 'ANDROID',
                clientVersion: '18.11.34',
                hl: 'en',
                gl: 'US'
            }
        },
        videoId: videoId
    }, {
        timeout: 25000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://m.youtube.com',
            'Referer': `https://m.youtube.com/watch?v=${videoId}`,
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache'
        }
    });
    
    const data = response.data;
    
    // Check if we got a valid response
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid response from YouTube API');
    }
    
    // Check for error responses
    if (data.error || data.playabilityStatus?.status === 'ERROR') {
        throw new Error(`YouTube API error: ${data.error?.message || data.playabilityStatus?.reason || 'Unknown error'}`);
    }
    
    const captions = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captions || captions.length === 0) {
        throw new Error('No captions found for this video');
    }
    
    let selectedCaption = captions.find(track => track.languageCode === lang);
    if (!selectedCaption) {
        selectedCaption = captions.find(track => 
            track.languageCode.startsWith(lang.split('-')[0])
        );
    }
    if (!selectedCaption) {
        selectedCaption = captions[0];
    }
    
    if (!selectedCaption || !selectedCaption.baseUrl) {
        throw new Error('No valid caption URL found');
    }
    
    const transcriptResponse = await axios.get(selectedCaption.baseUrl, {
        timeout: 15000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36',
            'Accept': 'application/xml, text/xml, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive'
        }
    });
    
    if (!transcriptResponse.data) {
        throw new Error('Empty transcript response');
    }
    
    const transcript = parseTranscriptXML(transcriptResponse.data);
    if (!transcript || transcript.length === 0) {
        throw new Error('No transcript content found after parsing');
    }
    
    return {
        transcript,
        language: selectedCaption.languageCode,
        availableLanguages: captions.map(track => ({
            code: track.languageCode,
            name: track.name?.simpleText || track.languageCode
        }))
    };
}

// Method 3: Using a third-party service as fallback
async function fetchTranscriptMethod3(videoId, lang = 'en') {
    // Using a free third-party service as fallback
    // This is a placeholder - you can replace with actual service
    try {
        // Option 1: Using a free transcript API service
        const response = await axios.get(`https://api.rapidapi.com/youtube-transcript/v1/transcript/${videoId}`, {
            timeout: 15000,
            headers: {
                'X-RapidAPI-Key': process.env.RAPIDAPI_KEY || 'demo-key',
                'X-RapidAPI-Host': 'youtube-transcript.p.rapidapi.com'
            }
        });
        
        if (response.data && response.data.transcript) {
            return {
                transcript: response.data.transcript.map(item => ({
                    text: item.text,
                    offset: item.start || 0,
                    duration: item.duration || 3.0
                })),
                language: response.data.language || lang,
                availableLanguages: response.data.availableLanguages || []
            };
        }
        
        throw new Error('Invalid response from third-party service');
        
    } catch (error) {
        // If third-party service fails, try alternative approach
        try {
            // Option 2: Using a different YouTube API endpoint
            const response = await axios.get(`https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}`, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                    'Accept': 'application/xml, text/xml, */*',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            });
            
            if (response.data) {
                const transcript = parseTranscriptXML(response.data);
                if (transcript && transcript.length > 0) {
                    return {
                        transcript,
                        language: lang,
                        availableLanguages: []
                    };
                }
            }
            
            throw new Error('Alternative method also failed');
            
        } catch (altError) {
            throw new Error(`Third-party service failed: ${error.message}. Alternative also failed: ${altError.message}`);
        }
    }
}

// Method 4: Using a different approach with more realistic headers
async function fetchTranscriptMethod4(videoId, lang = 'en') {
    const innertubeUrl = 'https://www.youtube.com/youtubei/v1/player';
    const response = await axios.post(innertubeUrl, {
        context: {
            client: {
                clientName: 'TVHTML5',
                clientVersion: '7.20210713.08.00',
                hl: 'en',
                gl: 'US'
            }
        },
        videoId: videoId
    }, {
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.81 TV Safari/537.36',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://www.youtube.com',
            'Referer': `https://www.youtube.com/tv#/watch?v=${videoId}`,
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache',
            'X-YouTube-Client-Name': '67'
        }
    });
    
    const data = response.data;
    
    // Check if we got a valid response
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid response from YouTube API');
    }
    
    // Check for error responses
    if (data.error || data.playabilityStatus?.status === 'ERROR') {
        throw new Error(`YouTube API error: ${data.error?.message || data.playabilityStatus?.reason || 'Unknown error'}`);
    }
    
    const captions = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captions || captions.length === 0) {
        throw new Error('No captions found for this video');
    }
    
    let selectedCaption = captions.find(track => track.languageCode === lang);
    if (!selectedCaption) {
        selectedCaption = captions.find(track => 
            track.languageCode.startsWith(lang.split('-')[0])
        );
    }
    if (!selectedCaption) {
        selectedCaption = captions[0];
    }
    
    if (!selectedCaption || !selectedCaption.baseUrl) {
        throw new Error('No valid caption URL found');
    }
    
    const transcriptResponse = await axios.get(selectedCaption.baseUrl, {
        timeout: 15000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36',
            'Accept': 'application/xml, text/xml, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive'
        }
    });
    
    if (!transcriptResponse.data) {
        throw new Error('Empty transcript response');
    }
    
    const transcript = parseTranscriptXML(transcriptResponse.data);
    if (!transcript || transcript.length === 0) {
        throw new Error('No transcript content found after parsing');
    }
    
    return {
        transcript,
        language: selectedCaption.languageCode,
        availableLanguages: captions.map(track => ({
            code: track.languageCode,
            name: track.name?.simpleText || track.languageCode
        }))
    };
}

// Method 5: Direct approach with minimal headers and delays
async function fetchTranscriptMethod5(videoId, lang = 'en') {
    // Add a small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const innertubeUrl = 'https://www.youtube.com/youtubei/v1/player';
    const response = await axios.post(innertubeUrl, {
        context: {
            client: {
                clientName: 'WEB',
                clientVersion: '2.20250710.09.00',
                hl: 'en',
                gl: 'US'
            }
        },
        videoId: videoId
    }, {
        timeout: 35000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'Origin': 'https://www.youtube.com',
            'Referer': `https://www.youtube.com/watch?v=${videoId}`,
            'Connection': 'keep-alive',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        }
    });
    
    const data = response.data;
    
    // Check if we got a valid response
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid response from YouTube API');
    }
    
    // Check for error responses
    if (data.error || data.playabilityStatus?.status === 'ERROR') {
        throw new Error(`YouTube API error: ${data.error?.message || data.playabilityStatus?.reason || 'Unknown error'}`);
    }
    
    const captions = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captions || captions.length === 0) {
        throw new Error('No captions found for this video');
    }
    
    let selectedCaption = captions.find(track => track.languageCode === lang);
    
    if (!selectedCaption) {
        selectedCaption = captions.find(track => 
            track.languageCode === 'auto' && track.name?.simpleText?.includes(lang)
        );
    }
    
    if (!selectedCaption) {
        selectedCaption = captions.find(track => 
            track.languageCode.startsWith(lang.split('-')[0])
        );
    }
    
    if (!selectedCaption) {
        selectedCaption = captions[0];
    }
    
    if (!selectedCaption || !selectedCaption.baseUrl) {
        throw new Error('No valid caption URL found');
    }
    
    // Add another small delay before fetching transcript
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const transcriptResponse = await axios.get(selectedCaption.baseUrl, {
        timeout: 20000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
            'Accept': 'application/xml, text/xml, */*',
            'Accept-Language': 'en-US,en;q=0.5',
            'Connection': 'keep-alive'
        }
    });
    
    if (!transcriptResponse.data) {
        throw new Error('Empty transcript response');
    }
    
    const transcript = parseTranscriptXML(transcriptResponse.data);
    if (!transcript || transcript.length === 0) {
        throw new Error('No transcript content found after parsing');
    }
    
    return {
        transcript,
        language: selectedCaption.languageCode,
        availableLanguages: captions.map(track => ({
            code: track.languageCode,
            name: track.name?.simpleText || track.languageCode
        }))
    };
}

// Method 6: Using a different YouTube API endpoint
async function fetchTranscriptMethod6(videoId, lang = 'en') {
    // Try using the older YouTube API endpoint
    const response = await axios.get(`https://www.youtube.com/get_video_info?video_id=${videoId}`, {
        timeout: 25000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        }
    });
    
    if (!response.data) {
        throw new Error('No response from YouTube get_video_info');
    }
    
    // Parse the response to extract caption tracks
    const data = response.data;
    const captionTracksMatch = data.match(/caption_tracks":\s*(\[.*?\])/);
    
    if (!captionTracksMatch) {
        throw new Error('No caption tracks found in video info');
    }
    
    try {
        const captionTracks = JSON.parse(captionTracksMatch[1]);
        
        if (!captionTracks || captionTracks.length === 0) {
            throw new Error('No captions available');
        }
        
        let selectedCaption = captionTracks.find(track => track.languageCode === lang);
        if (!selectedCaption) {
            selectedCaption = captionTracks.find(track => 
                track.languageCode.startsWith(lang.split('-')[0])
            );
        }
        if (!selectedCaption) {
            selectedCaption = captionTracks[0];
        }
        
        if (!selectedCaption || !selectedCaption.baseUrl) {
            throw new Error('No valid caption URL found');
        }
        
        const transcriptResponse = await axios.get(selectedCaption.baseUrl, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/xml, text/xml, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Connection': 'keep-alive'
            }
        });
        
        if (!transcriptResponse.data) {
            throw new Error('Empty transcript response');
        }
        
        const transcript = parseTranscriptXML(transcriptResponse.data);
        if (!transcript || transcript.length === 0) {
            throw new Error('No transcript content found after parsing');
        }
        
        return {
            transcript,
            language: selectedCaption.languageCode,
            availableLanguages: captionTracks.map(track => ({
                code: track.languageCode,
                name: track.name || track.languageCode
            }))
        };
        
    } catch (parseError) {
        throw new Error(`Failed to parse caption tracks: ${parseError.message}`);
    }
}

// Main transcript extraction with multiple fallback methods
async function fetchTranscript(videoId, lang = 'en', retryCount = 0) {
    const maxRetries = 3;
    const methods = [
        { name: 'Primary (Web)', fn: fetchTranscriptMethod1 },
        { name: 'Alternative (Mobile)', fn: fetchTranscriptMethod2 },
        { name: 'Third-party', fn: fetchTranscriptMethod3 },
        { name: 'Smart TV', fn: fetchTranscriptMethod4 }, // Added new method
        { name: 'Direct (Minimal Headers)', fn: fetchTranscriptMethod5 }, // Added new method
        { name: 'Alternative (Old API)', fn: fetchTranscriptMethod6 } // Added new method
    ];
    
    let lastError = null;
    let blockingDetected = false;
    
    for (let i = 0; i < methods.length; i++) {
        const method = methods[i];
        try {
            console.log(`Trying method ${i + 1}: ${method.name}`);
            const result = await method.fn(videoId, lang);
            console.log(`✓ Method ${i + 1} succeeded`);
            return {
                ...result,
                method: method.name
            };
        } catch (error) {
            console.log(`✗ Method ${i + 1} failed: ${error.message}`);
            lastError = error;
            
            // Check if this looks like IP blocking
            if (error.message.includes('blocking') || 
                error.message.includes('429') || 
                error.message.includes('rate limit') ||
                error.message.includes('No captions found') ||
                error.message.includes('Invalid response')) {
                blockingDetected = true;
            }
            
            // If it's a rate limit error, wait before trying next method
            if (error.message.includes('429') || error.message.includes('rate limit')) {
                console.log('Rate limit detected, waiting 3 seconds...');
                await new Promise(resolve => setTimeout(resolve, 3000));
            } else if (blockingDetected) {
                // If blocking is detected, add a longer delay
                console.log('Potential blocking detected, waiting 2 seconds...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    
    // If all methods failed and we have retries left
    if (retryCount < maxRetries && (
        lastError.message.includes('timeout') || 
        lastError.message.includes('network') ||
        lastError.message.includes('ECONNRESET') ||
        lastError.message.includes('ENOTFOUND') ||
        blockingDetected
    )) {
        console.log(`Retrying... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 3000 + (retryCount * 2000)));
        return fetchTranscript(videoId, lang, retryCount + 1);
    }
    
    // Provide more specific error messages
    if (blockingDetected) {
        throw new Error(`YouTube appears to be blocking requests from this IP. All ${methods.length} methods failed. Last error: ${lastError.message}`);
    } else {
        throw new Error(`All ${methods.length} methods failed. Last error: ${lastError.message}`);
    }
}

// Main transcript route
app.get('/transcript/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const { lang = 'en' } = req.query;
        const actualVideoId = extractVideoId(videoId) || videoId;
        
        if (!actualVideoId) {
            return res.status(400).json({
                error: 'Invalid YouTube video ID or URL',
                provided: videoId
            });
        }

        const startTime = Date.now();
        const result = await fetchTranscript(actualVideoId, lang);
        const processingTime = Date.now() - startTime;
        
        const fullText = result.transcript.map(item => item.text).join(' ');
        
        res.json({
            videoId: actualVideoId,
            language: result.language,
            transcript: result.transcript,
            fullText: fullText,
            availableLanguages: result.availableLanguages,
            method: result.method,
            stats: {
                totalSegments: result.transcript.length,
                totalCharacters: fullText.length,
                processingTime: processingTime
            }
        });

    } catch (error) {
        res.status(404).json({
            error: 'No transcript available for this video',
            videoId: req.params.videoId,
            requestedLanguage: req.query.lang || 'en',
            details: error.message
        });
    }
});

// Debug endpoint to test all methods
app.get('/debug/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const { lang = 'en' } = req.query;
        const actualVideoId = extractVideoId(videoId) || videoId;
        
        if (!actualVideoId) {
            return res.status(400).json({
                error: 'Invalid YouTube video ID or URL',
                provided: videoId
            });
        }

        const methods = [
            { name: 'Primary (Web)', fn: fetchTranscriptMethod1 },
            { name: 'Alternative (Mobile)', fn: fetchTranscriptMethod2 },
            { name: 'Third-party', fn: fetchTranscriptMethod3 },
            { name: 'Smart TV', fn: fetchTranscriptMethod4 }, // Added new method
            { name: 'Direct (Minimal Headers)', fn: fetchTranscriptMethod5 }, // Added new method
            { name: 'Alternative (Old API)', fn: fetchTranscriptMethod6 } // Added new method
        ];
        
        const results = [];
        
        for (const method of methods) {
            const startTime = Date.now();
            try {
                const result = await method.fn(actualVideoId, lang);
                const processingTime = Date.now() - startTime;
                
                results.push({
                    name: method.name,
                    success: true,
                    hasContent: result.transcript.length > 0,
                    transcriptLength: result.transcript.length,
                    processingTime: processingTime,
                    language: result.language
                });
            } catch (error) {
                const processingTime = Date.now() - startTime;
                results.push({
                    name: method.name,
                    success: false,
                    error: error.message,
                    processingTime: processingTime
                });
            }
        }
        
        res.json({
            videoId: actualVideoId,
            methods: results
        });

    } catch (error) {
        res.status(500).json({
            error: 'Debug failed',
            details: error.message
        });
    }
});

// POST route
app.post('/transcript', async (req, res) => {
    try {
        const { videoId, videoUrl, lang = 'en' } = req.body;
        
        if (!videoId && !videoUrl) {
            return res.status(400).json({
                error: 'Please provide either videoId or videoUrl'
            });
        }

        const actualVideoId = videoId || extractVideoId(videoUrl);
        
        if (!actualVideoId) {
            return res.status(400).json({
                error: 'Invalid YouTube video ID or URL',
                provided: videoId || videoUrl
            });
        }

        const startTime = Date.now();
        const result = await fetchTranscript(actualVideoId, lang);
        const processingTime = Date.now() - startTime;
        
        const fullText = result.transcript.map(item => item.text).join(' ');

        res.json({
            videoId: actualVideoId,
            language: result.language,
            transcript: result.transcript,
            fullText: fullText,
            availableLanguages: result.availableLanguages,
            method: result.method,
            stats: {
                totalSegments: result.transcript.length,
                totalCharacters: fullText.length,
                processingTime: processingTime
            }
        });

    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch transcript',
            details: error.message
        });
    }
});

// Health check route
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString()
    });
});

// Root route
app.get('/', (req, res) => {
    res.json({
        message: 'YouTube Transcript API',
        endpoints: {
            'GET /transcript/:videoId': 'Get transcript by video ID or URL',
            'POST /transcript': 'Get transcript by sending data in request body',
            'GET /debug/:videoId': 'Debug all methods for a video',
            'GET /health': 'Health check'
        }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        availableEndpoints: [
            'GET /transcript/:videoId',
            'POST /transcript',
            'GET /debug/:videoId',
            'GET /health',
            'GET /'
        ]
    });
});

app.listen(PORT, () => {
    console.log(`YouTube Transcript API running on port ${PORT}`);
});

module.exports = app;