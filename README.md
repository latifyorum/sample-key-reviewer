# Sample Key Reviewer

Ses dosyalarının (özellikle drum sample'larının ve loop'ların) key / nota bilgisini otomatik tespit eden, adayları gösteren ve **sen onayladıktan sonra** dosya adına key etiketini ekleyen, yerel çalışan bir web uygulaması.

```
808 Bass.wav   →   808 Bass [F#1].wav
Pad Loop.wav   →   Pad Loop [Am].wav
```

Dosyaların bilgisayarından çıkmaz: analiz yerel bir Python servisinde yapılır, sample'lar bir sunucuya yüklenmez.

## Özellikler

- **İki analiz modu**
  - **Pitch (tek nota):** 808, kick, tom gibi tek vuruşlarda temel frekansı bulup nota üretir. Oktav hatası düzeltmesi ve yarım ton komşu adayları vardır.
  - **Key (tonalite):** Loop'lar ve uzun dosyalarda Krumhansl-Schmuckler profilleriyle 24 majör/minör aday arasında korelasyon hesaplar. Analizden önce davul/perküsyon bastırılır.
  - **Auto:** Süre eşiğinin altındaki ve en fazla iki vuruş içeren dosyalar pitch, diğerleri key modunda analiz edilir.
- **Güven seviyeleri:** Yüksek / orta / düşük güven ve "tespit edilemedi" (atonal). Atonal dosyalara (hi-hat, saf drum loop) etiket önerilmez.
- **Adayları incele:** Her dosyada adaylar skorlarıyla listelenir. Orijinal sample'ı dinleyebilir, piyano referansıyla A/B karşılaştırma yapabilirsin.
- **Güvenli adlandırma:** Dosya adı yalnızca onayından sonra değişir. Var olan bir dosyanın üzerine asla yazılmaz. Adında zaten key etiketi olan dosyalar, "Var olan key etiketini değiştir" seçilmedikçe atlanır.
- **İşlem günlüğü ve geri alma:** Her adlandırma eski/yeni adıyla bir CSV günlüğüne yazılır; en son işlem geri alınabilir.
- **Önbellek:** Analiz sonuçları dosya boyutu ve değişiklik zamanına göre saklanır; aynı klasörü yeniden taramak hızlıdır.

Desteklenen formatlar: `.wav`, `.aif`, `.aiff`, `.flac`, `.mp3`, `.ogg`

## Kurulum

Gereksinimler: Python 3.9 veya üstü (3.12 ile denendi).

```bash
git clone https://github.com/latifyorum/sample-key-reviewer.git
cd sample-key-reviewer
pip install -r requirements.txt
python app.py
```

Tarayıcı otomatik olarak `http://127.0.0.1:5173` adresini açar. Sayfayı dosyaya çift tıklayarak açmak çalışmaz; uygulama `app.py` ile çalıştırılmalıdır.

> **İlk çalıştırma:** Analiz kütüphanesi (librosa) ilk kullanımda kendini derler. Uygulama açılışta bunu arka planda ısıtır; terminalde `Analiz motoru hazır.` yazısını görene kadar ilk sonuçlar 30-60 saniye gecikebilir.

### Komut satırı seçenekleri

```bash
python app.py                                  # varsayılan
python app.py "D:/Samples/Drums"               # açılışta bu klasörü tara
python app.py --port 8080                      # farklı port
python app.py --log "D:/Samples/gunluk.csv"    # günlük dosyasının yolu
python app.py --no-browser                     # tarayıcıyı otomatik açma
```

Varsayılan günlük yolu: `~/.key_renamer/islem_gunlugu.csv`

## Kullanım

1. Klasör yolunu yaz veya **Klasör seç**'e bas, istersen **Alt klasörler**'i işaretle, **Klasörü tara**'ya bas.
2. Soldaki listeden bir dosya seç. Analiz sonucunu, adayları ve güven durumunu gör.
3. Orijinal sample'ı ve referans notayı/akoru dinleyerek adayı doğrula. Gerekirse key'i elle yaz (örn. `Dm`, `F#1`).
4. **Key'i onayla**, ardından **Yeniden adlandır** (tek dosya) veya **Onaylıları yeniden adlandır** (toplu) ile uygula.
5. Hata yaptıysan **Geri al** en son işlemi geri alır.

### Analiz ayarları

| Ayar | Açıklama |
| --- | --- |
| Mod | `Auto`, `Pitch` (hepsi tek nota) veya `Key` (hepsi tonalite) |
| Pitch eşiği | Auto modda bu süreden (sn) kısa ve en fazla iki vuruşlu dosyalar pitch sayılır |
| Min. korelasyon | Key modunda bunun altı "tespit edilemedi" |
| Min. aday farkı | İlk iki aday arasındaki fark bunun altındaysa düşük güven |
| Bemol yazımı | `C#` yerine `Db` gibi |

Ayarlar yeni taramada uygulanır.

## Nasıl çalışır?

- **Pitch:** Vuruşun atak kısmından sonraki bölüm FFT ile analiz edilir, parabolik interpolasyonla temel frekans bulunur, en yakın nota ve cent sapması hesaplanır. Spektrumda alt oktavda yeterli enerji varsa temel frekans oktav aşağı düzeltilir (808'lerde sık görülen hata).
- **Key:** Harmonik bileşen ayrıştırılır, kromagram ortalaması alınır ve 24 anahtar profiliyle korelasyon hesaplanır.

Skorlar sezgiseldir; kalibre edilmiş doğruluk yüzdeleri değildir. Belirsiz sonuçları kulağınla doğrulamak için tasarlanmıştır.

## Bilinen sınırlar

- Çok düşük 808'lerde (≈30 Hz civarı) ve çok kısa kick'lerde nota yarım ton kayabilir; bu durumda komşu nota aday olarak gösterilir.
- Pitch sweep'li kick'lerde nota tahmini belirsiz olabilir.
- Davul ağırlıklı loop'lar atonal çıkar; bu beklenen davranıştır.
- Piyano referansı Tone.js ve Salamander Grand Piano örneklerini internetten yükler; ilk kullanımda internet bağlantısı gerekir. Analiz ve dosya işlemleri internetsiz çalışır.
- **Klasör seç** düğmesi işletim sisteminin klasör penceresini açmak için Python'un `tkinter` modülünü kullanır. Açılmazsa klasör yolunu elle yazabilirsin.
- MP3 okuma desteği kurulu `soundfile`/libsndfile sürümüne bağlıdır.

## Güvenlik

Sunucu yalnızca `127.0.0.1`'e bağlanır, başka cihazlardan erişilemez. Yeniden adlandırma yalnızca taranan klasördeki, analiz edilmiş dosyalar için çalışır.

## Proje yapısı

```
app.py            Flask sunucusu, analiz ve dosya işlemleri
index.html        Arayüz
static/app.js     Arayüz mantığı
static/style.css  Stiller
requirements.txt  Python bağımlılıkları
```

## Lisans

[MIT](LICENSE)

## Üçüncü taraf bileşenler

- [Tone.js](https://tonejs.github.io/) (MIT), tarayıcıda ses motoru olarak CDN'den yüklenir.
- Salamander Grand Piano, Alexander Holm, [CC BY 3.0](https://github.com/sfzinstruments/SalamanderGrandPiano) (piyano referans örnekleri, depoda dağıtılmaz, çalışma sırasında internetten yüklenir).
- [Flask](https://flask.palletsprojects.com/), [librosa](https://librosa.org/), [SoundFile](https://python-soundfile.readthedocs.io/) ve [NumPy](https://numpy.org/).
- Yazı tipleri Google Fonts üzerinden yüklenir (DM Mono, Manrope).
