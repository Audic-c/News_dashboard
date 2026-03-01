# Premium News Aggregator

A modern, responsive HTML-based news aggregator that displays real-time news from premium publications worldwide.

## Features

- **Premium News Sources**: Integrates with 8 top-tier publications
  - The Economist
  - Financial Times
  - Bloomberg
  - The New York Times
  - Reuters
  - South China Morning Post
  - MIT Technology Review
  - The New Yorker

- **Modern Design**: Clean, professional interface with gradient backgrounds and smooth animations
- **Responsive Layout**: Works perfectly on desktop, tablet, and mobile devices
- **Real-time Updates**: Auto-refresh functionality with manual refresh option
- **Interactive Elements**: Click on news items to visit source websites
- **Export Functionality**: Download news source configuration as JSON

## Files Included

1. **index.html** - Basic news aggregator with sample data
2. **news-aggregator.html** - Advanced version with enhanced features
3. **README.md** - This documentation file

## Usage

### Basic Version (index.html)
- Simple, lightweight design
- Sample news data for demonstration
- Perfect for quick setup and testing

### Advanced Version (news-aggregator.html)
- Enhanced UI with glassmorphism effects
- RSS feed integration capabilities
- Auto-refresh functionality
- Export features
- Status indicators

## Setup Instructions

1. Open either `index.html` or `news-aggregator.html` in your web browser
2. For the best experience, use a modern browser (Chrome, Firefox, Safari, Edge)
3. The news aggregator will load with sample data
4. Click on any news item to visit the source website
5. Use the refresh button to update content

## Technical Details

### Technologies Used
- HTML5
- CSS3 (with Flexbox and Grid)
- Vanilla JavaScript
- Font Awesome icons
- Google Fonts (Inter)

### Features Implementation
- **Responsive Design**: Uses CSS Grid and Flexbox for adaptive layouts
- **Animations**: CSS transitions and keyframe animations for smooth interactions
- **RSS Integration**: Prepared for RSS feed integration with fallback to sample data
- **Cross-browser Compatibility**: Works on all modern browsers

### RSS Feed Integration
The advanced version includes RSS feed integration capabilities using:
- RSS2JSON API for converting RSS feeds to JSON
- CORS proxy support for cross-origin requests
- Fallback to sample data when RSS feeds are unavailable

## Customization

### Adding New Sources
To add new news sources, modify the `newsSources` array in the JavaScript section:

```javascript
{
    id: 'your-source',
    name: 'Your News Source',
    url: 'https://your-source.com/',
    logo: 'YS',
    color: '#your-color',
    category: 'Your Category',
    rssUrl: 'https://your-source.com/rss/'
}
```

### Styling Customization
- Modify CSS variables for color schemes
- Adjust gradients in the `background` properties
- Customize fonts and typography
- Change spacing and layout dimensions

## Browser Support

- Chrome 60+
- Firefox 55+
- Safari 11+
- Edge 79+

## Performance

- Lightweight implementation with minimal dependencies
- Efficient DOM manipulation
- Optimized for fast loading
- Mobile-first responsive design

## Future Enhancements

- Real RSS feed integration
- Search functionality
- Category filtering
- Dark mode toggle
- Offline support
- Push notifications
- Social sharing

## License

This project is open source and available under the MIT License.

## Support

For issues or questions, please check the browser console for any error messages and ensure you're using a modern browser with JavaScript enabled.