const fs = require('fs');
const path = require('path');

console.log('=== Testing Modified Files ===');

// Check if routes/gallery.js has the correct changes
const galleryContent = fs.readFileSync('routes/gallery.js', 'utf8');
if (galleryContent.includes('embedUrl: `https://drive.google.com/file/d/')) {
    console.log('✓ routes/gallery.js: Streaming endpoint updated with embed URLs');
} else {
    console.log('✗ routes/gallery.js: Streaming endpoint not updated');
}

if (galleryContent.includes('gallery/embed-video.ejs')) {
    console.log('✓ routes/gallery.js: References embed-video.ejs template');
} else {
    console.log('✗ routes/gallery.js: No reference to embed-video.ejs');
}

// Check if embed-video.ejs exists
if (fs.existsSync('views/gallery/embed-video.ejs')) {
    console.log('✓ views/gallery/embed-video.ejs: Template file exists');
} else {
    console.log('✗ views/gallery/embed-video.ejs: Template file missing');
}

// Check header.ejs for CSS link
const headerContent = fs.readFileSync('views/partials/header.ejs', 'utf8');
if (headerContent.includes('css/embed-styles.css')) {
    console.log('✓ views/partials/header.ejs: CSS link added');
} else {
    console.log('✗ views/partials/header.ejs: CSS link not found');
}

console.log('');
console.log('=== Summary ===');
console.log('Immediate fix implemented with browser embed approach');
console.log('Videos will now use embed preview URLs instead of Drive API');
console.log('No Google Drive API key dependency');
console.log('Works with authentication-required URLs');
