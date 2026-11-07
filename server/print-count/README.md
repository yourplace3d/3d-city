# Print counter

One small PHP script that counts how many people say they're printing their model. It's the only
server part of Your Place, and it's optional: the app works the same without it.

- **What it stores:** a total per print size, in `counts/print-counts.json`. Nothing else: no IP
  address, no place, no time, no cookie.
- **When it's called:** only when a visitor presses "Yes, I'm printing it" after "Order a print
  online" in the share menu. The app sends `{"size":15,"tiles":1}` with `navigator.sendBeacon`.
- **Where:** `https://count.yourplace3d.com/print.php` (`PRINT_COUNT_URL` in `src/main.ts`).

## Setup on Hostinger

1. Add the domain `yourplace3d.com` to the hosting plan, and turn on domain privacy (WHOIS
   protection).
2. Create the subdomain `count.yourplace3d.com` and turn on SSL (the free certificate).
3. Upload `print.php` and the `counts` folder, with its `.htaccess`, into the subdomain's folder
   (for example `domains/yourplace3d.com/public_html/count/`).
4. Test it from a terminal:
   - `curl -i -X POST https://count.yourplace3d.com/print.php -d '{"size":15,"tiles":1}'` answers
     `204`, and `counts/print-counts.json` now shows 1.
   - `curl -i https://count.yourplace3d.com/print.php` answers `405` (only POST counts).
   - `curl -i https://count.yourplace3d.com/counts/print-counts.json` answers `403` (the totals stay
     private).
5. Reset the test count: delete `counts/print-counts.json` in the file manager.

## Reading the numbers

Open `counts/print-counts.json` in the file manager:

```json
{ "total": 12, "by_size": { "15 cm": 8, "20 cm": 3, "10 cm, 2 × 2 tiles": 1 }, "minute": "…", "in_minute": 0 }
```

`minute` and `in_minute` are the flood cap: at most 30 counts a minute, for everyone together.
