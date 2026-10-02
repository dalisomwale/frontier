# Photo Credits

The homepage hero and category tiles use real photographs (no AI-generated
images) from [Unsplash](https://unsplash.com), under the
[Unsplash License](https://unsplash.com/license): free to use for commercial
and non-commercial purposes, no permission needed. Attribution isn't required
and the credits are not shown on the site; this file keeps the record.

Each photo was checked on its Unsplash page for location, camera and licence
before use. They load from Unsplash's image CDN (`images.unsplash.com`) at a
width matched to the visitor's screen.

| Place | Photographer | Unsplash page |
|---|---|---|
| Kabwe, Zambia | Mwandwe Chileshe | https://unsplash.com/photos/a-brown-and-white-calf-rests-in-green-grass-_q4s7f6JTTU |
| Great Rift Valley, Kenya | Sweder Breet | https://unsplash.com/photos/a-herd-of-cattle-standing-next-to-a-body-of-water-Cjbb9aeHeD8 |
| Osun, Nigeria | Fahd Aminu | https://unsplash.com/photos/man-milking-a-white-cow-in-a-field-NQg7R0euxyc |
| Senegal | Carlos Torres | https://unsplash.com/photos/a-herd-of-cattle-walking-down-a-dirt-road-QS_0VPaTpco |
| Mauritania | Baptiste Riethmann | https://unsplash.com/photos/cattle-walking-along-a-dry-path-with-tall-reeds-6WIV4VXsRA4 |

The list lives in `public/js/livestock.js` (`HERO_PHOTOS`). To swap in your own
farm photography, add the files to `public/images/` and replace the entries.

`public/images/livestock/hero-fallback.webp` and `cattle-fallback.webp` are the
photos from v1 of the site, recompressed. They show while the hero photos load
or if Unsplash can't be reached.
