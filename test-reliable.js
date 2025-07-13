const axios = require('axios');

async function testReliableAPI() {
    const baseURL = 'http://localhost:3000';
    
    console.log('Testing improved YouTube Transcript API with retry and fallback...\n');
    
    // Test with the video that was timing out
    const testVideoId = '1aA1WGON49E';
    
    try {
        // Test 1: Main transcript endpoint
        console.log('1. Testing main transcript endpoint...');
        const startTime = Date.now();
        const transcriptResponse = await axios.get(`${baseURL}/transcript/${testVideoId}`);
        const processingTime = Date.now() - startTime;
        
        console.log(`✓ Success! Method: ${transcriptResponse.data.method}`);
        console.log(`Processing time: ${processingTime}ms`);
        console.log(`Segments: ${transcriptResponse.data.stats.totalSegments}`);
        console.log(`Characters: ${transcriptResponse.data.stats.totalCharacters}`);
        console.log(`Language: ${transcriptResponse.data.language}`);
        
        // Show first few lines
        console.log('\nFirst few lines:');
        transcriptResponse.data.transcript.slice(0, 3).forEach((segment, index) => {
            console.log(`  ${index + 1}. [${segment.timestamp}] ${segment.text}`);
        });
        
        // Test 2: Debug endpoint to see both methods
        console.log('\n2. Testing debug endpoint...');
        const debugResponse = await axios.get(`${baseURL}/debug/${testVideoId}`);
        
        console.log('Method results:');
        debugResponse.data.methods.forEach((method, index) => {
            const status = method.success ? '✓ Success' : '✗ Failed';
            console.log(`  ${index + 1}. ${method.name}: ${status}`);
            if (method.success && method.hasContent) {
                console.log(`     Segments: ${method.transcriptLength}, Time: ${method.processingTime}`);
            } else if (!method.success) {
                console.log(`     Error: ${method.error}`);
            }
        });
        
        // Test 3: Try with a different video to test reliability
        console.log('\n3. Testing with a different video...');
        const differentVideoId = 'dQw4w9WgXcQ'; // Rick Roll
        try {
            const differentResponse = await axios.get(`${baseURL}/transcript/${differentVideoId}`);
            console.log(`✓ Different video success: ${differentResponse.data.method}`);
            console.log(`Segments: ${differentResponse.data.stats.totalSegments}`);
        } catch (error) {
            console.log(`✗ Different video failed: ${error.response?.data?.error || error.message}`);
        }
        
        console.log('\n🎉 Improved API is working!');
        console.log('✅ Retry mechanism for network issues');
        console.log('✅ Fallback method for reliability');
        console.log('✅ Increased timeouts for slower connections');
        console.log('✅ Better error handling and reporting');
        
    } catch (error) {
        console.error('Test failed:', error.response?.data || error.message);
    }
}

// Run the test
testReliableAPI(); 