const express = require('express');
const axios = require('axios');
const cors = require('cors');
const serverless = require('serverless-http');

const app = express();

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

// Main transcript extraction method - optimized for Netlify Functions
async function fetchTranscript(videoId, lang = 'en', retryCount = 0) {
    const maxRetries = 1; // Reduced for serverless
    
    try {
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
            timeout: 8000, // Reduced timeout for serverless
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://www.youtube.com',
                'Referer': `https://www.youtube.com/watch?v=${videoId}`,
                'Connection': 'keep-alive'
            }
        });
        
        const data = response.data;
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
        
        const transcriptResponse = await axios.get(selectedCaption.baseUrl, {
            timeout: 6000, // Reduced timeout for serverless
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/xml, text/xml, */*',
                'Accept-Language': 'en-US,en;q=0.9'
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
        
    } catch (error) {
        if (retryCount < maxRetries && (
            error.message.includes('timeout') || 
            error.message.includes('network') ||
            error.message.includes('ECONNRESET') ||
            error.message.includes('ENOTFOUND')
        )) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Reduced delay
            return fetchTranscript(videoId, lang, retryCount + 1);
        }
        
        throw new Error(`Failed to fetch transcript: ${error.message}`);
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

        const result = await fetchTranscript(actualVideoId, lang);
        const fullText = result.transcript.map(item => item.text).join(' ');

        res.json({
            videoId: actualVideoId,
            language: result.language,
            transcript: result.transcript,
            fullText: fullText,
            availableLanguages: result.availableLanguages
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

        const result = await fetchTranscript(actualVideoId, lang);
        const fullText = result.transcript.map(item => item.text).join(' ');

        res.json({
            videoId: actualVideoId,
            language: result.language,
            transcript: result.transcript,
            fullText: fullText,
            availableLanguages: result.availableLanguages
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
        timestamp: new Date().toISOString(),
        environment: 'netlify-functions'
    });
});

// Root route
app.get('/', (req, res) => {
    res.json({
        message: 'YouTube Transcript API',
        environment: 'netlify-functions',
        endpoints: {
            'GET /transcript/:videoId': 'Get transcript by video ID or URL',
            'POST /transcript': 'Get transcript by sending data in request body',
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
            'GET /health',
            'GET /'
        ]
    });
});

// Export for Netlify Functions
module.exports.handler = serverless(app); 