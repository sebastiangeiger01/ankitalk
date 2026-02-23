import sharp from 'sharp';

const sizes = [
	{ name: 'icon-192.png', size: 192 },
	{ name: 'icon-512.png', size: 512 },
	{ name: 'icon-512-maskable.png', size: 512, maskable: true }
];

for (const { name, size, maskable } of sizes) {
	// Maskable icons need 20% safe zone padding
	const fontSize = maskable ? Math.floor(size * 0.55) : Math.floor(size * 0.7);
	const yOffset = maskable ? Math.floor(size * 0.55) : Math.floor(size * 0.52);

	const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
		<rect width="${size}" height="${size}" rx="${Math.floor(size * 0.15)}" fill="#1a1a2e"/>
		<text x="50%" y="${yOffset}" text-anchor="middle" font-size="${fontSize}">🎙️</text>
	</svg>`;

	await sharp(Buffer.from(svg))
		.png()
		.toFile(`static/icons/${name}`);

	console.log(`Created static/icons/${name} (${size}x${size})`);
}

// Also create a favicon
const faviconSvg = `<svg width="32" height="32" xmlns="http://www.w3.org/2000/svg">
	<rect width="32" height="32" rx="6" fill="#1a1a2e"/>
	<text x="50%" y="24" text-anchor="middle" font-size="22">🎙️</text>
</svg>`;

await sharp(Buffer.from(faviconSvg))
	.png()
	.toFile('static/favicon.png');

console.log('Created static/favicon.png');
