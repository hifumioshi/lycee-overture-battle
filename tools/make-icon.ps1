Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = [System.Drawing.Bitmap]::new($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

$rect = [System.Drawing.Rectangle]::new(0, 0, $size, $size)
$brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, [System.Drawing.Color]::FromArgb(255, 26, 35, 50), [System.Drawing.Color]::FromArgb(255, 64, 116, 198), 45)
$g.FillRectangle($brush, $rect)

$pen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 240, 230, 200), 10)
$cardRect = [System.Drawing.Rectangle]::new(28, 28, 200, 200)
$g.DrawRectangle($pen, $cardRect)

$font = [System.Drawing.Font]::new('Segoe UI', 72, [System.Drawing.FontStyle]::Bold)
$textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$fmt = [System.Drawing.StringFormat]::new()
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = [System.Drawing.RectangleF]::new(20, 60, 216, 140)
$g.DrawString('LO', $font, $textBrush, $textRect, $fmt)

$ms = [System.IO.MemoryStream]::new()
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $ms.ToArray()
$ms.Close()

$ico = [System.IO.MemoryStream]::new()
$bw = [System.IO.BinaryWriter]::new($ico)
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]1)
$bw.Write([byte]0)
$bw.Write([byte]0)
$bw.Write([byte]0)
$bw.Write([byte]0)
$bw.Write([uint16]1)
$bw.Write([uint16]32)
$bw.Write([uint32]$pngBytes.Length)
$bw.Write([uint32]22)
$bw.Write($pngBytes)
$bw.Flush()

$outDir = Join-Path (Get-Location) 'build'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$outFile = Join-Path $outDir 'icon.ico'
[System.IO.File]::WriteAllBytes($outFile, $ico.ToArray())
$ico.Close()
Write-Output ("icon written: " + $outFile + " (" + (Get-Item $outFile).Length + " bytes)")
