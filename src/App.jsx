import React, { useState, useEffect, useCallback } from "react";
import * as mobilenet from "@tensorflow-models/mobilenet";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import * as tf from "@tensorflow/tfjs";
import { Button } from "@/components/ui/button";
import { Loader2, Upload, Send } from "lucide-react";
import "./App.css";

function App() {
  const [image, setImage] = useState(null);
  const [message, setMessage] = useState("");
  const [mobilenetModel, setMobilenetModel] = useState(null);
  const [cocoModel, setCocoModel] = useState(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [lastImages, setLastImages] = useState([]);
  const [imageLoadStates, setImageLoadStates] = useState({});
  const [birdImage, setBirdImage] = useState(null);
  const [sending, setSending] = useState(false);
  const [showSendAnyway, setShowSendAnyway] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  const birdMessages = [
    "Check out this little beauty!",
    "Look at this absolute stunner!",
    "What a gorgeous bird!",
    "This one's a real looker!",
    "Behold this feathered friend!",
    "Check out this absolute unit!",
    "What a magnificent creature!",
    "Look at this beauty!",
    "This bird is incredible!",
    "What a stunning specimen!",
    "Check out this cutie!",
    "Look at this absolute gem!",
    "What a beautiful bird!",
    "This one's a real charmer!",
    "Behold this little legend!",
    "Check out this absolute beauty!",
    "What a gorgeous little bird!",
    "Look at this stunner!",
    "This bird is amazing!",
    "What a magnificent bird!",
    "Check out this feathered friend!",
    "Look at this absolute beauty!",
    "What a stunning bird!",
    "This one's incredible!",
    "Behold this gorgeous creature!",
    "Check out this looker!",
    "What a beautiful specimen!",
    "Look at this little gem!",
    "This bird is a real stunner!",
    "What an absolute beauty!",
  ];

  const birdClasses = [
    "cock",
    "hen",
    "ostrich",
    "brambling",
    "goldfinch",
    "house finch",
    "junco",
    "indigo bunting",
    "robin",
    "bulbul",
    "jay",
    "magpie",
    "chickadee",
    "water ouzel",
    "kite",
    "bald eagle",
    "vulture",
    "great grey owl",
    "black grouse",
    "ptarmigan",
    "ruffed grouse",
    "prairie chicken",
    "peacock",
    "quail",
    "partridge",
    "african grey",
    "macaw",
    "sulphur-crested cockatoo",
    "lorikeet",
    "coucal",
    "bee eater",
    "hornbill",
    "hummingbird",
    "jacamar",
    "toucan",
    "drake",
    "red-breasted merganser",
    "goose",
    "black swan",
    "white stork",
    "black stork",
    "spoonbill",
    "flamingo",
    "american egret",
    "little blue heron",
    "bittern",
    "crane",
    "limpkin",
    "american coot",
    "bustard",
    "ruddy turnstone",
    "red-backed sandpiper",
    "redshank",
    "dowitcher",
    "oystercatcher",
    "european gallinule",
    "pelican",
    "king penguin",
    "albatross",
  ];

  // R2 images are served through the Worker at /image/:filename
  const workerUrl = import.meta.env.VITE_WORKER_URL || '';

  const fetchLastImages = useCallback(async () => {
    try {
      // Use Worker endpoint to list images (keeps R2 credentials secure)
      const response = await fetch(`${workerUrl}/list`, {
        method: 'GET',
      });

      if (!response.ok) {
        console.error('Failed to fetch images:', response.statusText);
        return;
      }

      const data = await response.json();
      const lastItems = data.images || [];
      const imageUrls = lastItems.map(
        (item) => `${workerUrl}/image/${item.Key}`
      );

      setLastImages(imageUrls);
      // Reset load states for new images
      setImageLoadStates({});
    } catch (error) {
      console.error('Error fetching images:', error);
    }
  }, [workerUrl]);

  useEffect(() => {
    const loadModels = async () => {
      try {
        setModelsLoading(true);
        // Load both models in parallel
        const [loadedMobilenet, loadedCoco] = await Promise.all([
          mobilenet.load({ version: 2, alpha: 1.0 }),
          cocoSsd.load()
        ]);
        setMobilenetModel(loadedMobilenet);
        setCocoModel(loadedCoco);
        setModelsLoading(false);
        
        // Only fetch images after models are loaded
        // This ensures upload functionality is ready first
        fetchLastImages();
      } catch (error) {
        console.error('Error loading models:', error);
        setMessage('Error loading AI models. Please refresh the page.');
        setModelsLoading(false);
        // Still try to fetch images even if models fail
        fetchLastImages();
      }
    };

    loadModels();
  }, [fetchLastImages]);

  const handleImageUpload = (event) => {
    const DESIRED_WIDTH = 400; 
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const imgElement = new Image();
            imgElement.src = e.target.result;
            imgElement.onload = () => {
                const canvas = document.createElement('canvas');
                const scaleFactor = DESIRED_WIDTH / imgElement.width;
                canvas.width = DESIRED_WIDTH;
                canvas.height = imgElement.height * scaleFactor;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(imgElement, 0, 0, canvas.width, canvas.height);
                const jpegImage = canvas.toDataURL('image/jpeg', 0.5);
                setImage(jpegImage);
                setShowSendAnyway(false);
                setAnalyzing(true);
                classifyImage(imgElement);
            };
        };
        reader.readAsDataURL(file);
    }
}

  const classifyImage = async (imgElement) => {
    if (!cocoModel || !mobilenetModel) {
      setMessage("AI models are still loading. Please wait...");
      setAnalyzing(false);
      return;
    }

    try {
      // First, try COCO-SSD for bird detection (better for detecting birds at various distances)
      const cocoPredictions = await cocoModel.detect(imgElement);
      console.log('COCO-SSD predictions:', cocoPredictions);

      // Check if COCO-SSD detected a bird
      const birdDetectedByCoco = cocoPredictions.some(
        (prediction) => prediction.class === 'bird'
      );

      if (birdDetectedByCoco) {
        // Bird detected by COCO-SSD, now use MobileNet for classification
        const tensor = tf.browser
          .fromPixels(imgElement)
          .resizeNearestNeighbor([224, 224])
          .toFloat()
          .expandDims();
        const mobilenetPredictions = await mobilenetModel.classify(tensor);
        tensor.dispose(); // Clean up tensor
        console.log('MobileNet predictions:', mobilenetPredictions);

        const birdDetectedByMobilenet = mobilenetPredictions.some((prediction) =>
          birdClasses.includes(prediction.className.toLowerCase())
        );

        if (birdDetectedByMobilenet) {
          setMessage(
            "Woah that bird is crazy, looks like a " +
              mobilenetPredictions[0].className +
              "! You should send it to Ryan!"
          );
        } else {
          setMessage(
            "Bird detected! (Looks like a " +
              mobilenetPredictions[0].className +
              ") You should send it to Ryan!"
          );
        }
        setBirdImage(imgElement);
        setShowSendAnyway(false);
      } else {
        // No bird detected by COCO-SSD, try MobileNet as fallback
        const tensor = tf.browser
          .fromPixels(imgElement)
          .resizeNearestNeighbor([224, 224])
          .toFloat()
          .expandDims();
        const mobilenetPredictions = await mobilenetModel.classify(tensor);
        tensor.dispose(); // Clean up tensor

        const birdDetectedByMobilenet = mobilenetPredictions.some((prediction) =>
          birdClasses.includes(prediction.className.toLowerCase())
        );

        if (birdDetectedByMobilenet) {
          setMessage(
            "Woah that bird is crazy, looks like a " +
              mobilenetPredictions[0].className +
              "! You should send it to Ryan!"
          );
          setBirdImage(imgElement);
          setShowSendAnyway(false);
        } else {
          // No bird detected by either model
          setMessage(
            "No bird detected in this image. I think it might be a " +
              mobilenetPredictions[0].className +
              ". Are you sure there's a bird?"
          );
          setBirdImage(imgElement); // Still allow sending
          setShowSendAnyway(true); // Show "send anyway" option
        }
      }
    } catch (error) {
      console.error('Error classifying image:', error);
      setMessage("Error analyzing image. You can still send it if you want!");
      setBirdImage(imgElement);
      setShowSendAnyway(true);
    } finally {
      setAnalyzing(false);
    }
  };

  const uploadToR2 = async (imgElement) => {
    setSending(true);
    const fileName = `bird-${Date.now()}.jpeg`;

    const canvas = document.createElement("canvas");
    canvas.width = imgElement.naturalWidth;
    canvas.height = imgElement.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imgElement, 0, 0);

    canvas.toBlob(async (blob) => {
      try {
        // Convert blob to base64 for easier transmission
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64data = reader.result.split(',')[1];
          
          // Upload via Worker proxy to keep R2 credentials secure
          const response = await fetch(`${workerUrl}/upload`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              fileName: fileName,
              fileData: base64data,
              contentType: 'image/jpeg',
            }),
          });

          if (!response.ok) {
            const errorData = await response.json();
            console.error('Upload error:', errorData);
            setMessage("Failed to upload image. Please try again.");
            setSending(false);
            return;
          }

          const data = await response.json();
          // Use the filename returned by the Worker (it may have been sanitized/renamed)
          const uploadedFileName = data.fileName || fileName;
          const imageUrl = `${workerUrl}/image/${uploadedFileName}`;
          console.log(`File uploaded successfully at ${imageUrl}`);
          sendSMS(imageUrl);
        };
        reader.readAsDataURL(blob);
      } catch (error) {
        console.error('Upload error:', error);
        setMessage("Failed to upload image. Please try again.");
        setSending(false);
      }
    }, "image/jpeg");
  };

  const getRandomBirdMessage = () => {
    return birdMessages[Math.floor(Math.random() * birdMessages.length)];
  };

  const sendSMS = async (imageUrl) => {
    try {
      const response = await fetch(
        `${workerUrl}/sms`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: getRandomBirdMessage(),
            recipientPhoneNumber: "+17573030776",
            mediaUrl: imageUrl,
          }),
        }
      );

      if (response.ok) {
        alert("The bird has been sent to Ryan, you're a hero!");
        // reload the app to show the latest images
        window.location.reload();
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.error('SMS error:', errorData);
        alert("Failed to send message. Try again!");
        setSending(false);
      }
    } catch (error) {
      console.error('SMS error:', error);
      alert("An error occurred. Please try again.");
      setSending(false);
    }
  };

  const handleBirdSend = () => {
    uploadToR2(birdImage);
  };

  return (
    <div className="App">
      <h1 className="text-5xl md:text-6xl lg:text-7xl font-extrabold mb-8 text-center text-white tracking-tight drop-shadow-2xl">
        Send Ryan A Bird
      </h1>
      <div className="upload-area">
        <div className="relative w-full max-w-md">
          <input
            type="file"
            accept="image/*"
            onInput={handleImageUpload}
            disabled={modelsLoading || analyzing || sending}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed z-10 disabled:pointer-events-none"
            id="file-upload"
          />
          <Button
            size="lg"
            disabled={modelsLoading || analyzing || sending}
            className="w-full pointer-events-none"
            variant={modelsLoading ? "secondary" : "default"}
          >
            {modelsLoading ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Bird experts loading... <br />
                This may take a while on slower connections.
              </>
            ) : analyzing || sending ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                {analyzing ? "Analyzing..." : "Sending..."}
              </>
            ) : (
              <>
                <Upload className="mr-2 h-5 w-5" />
                Upload Bird Photo
              </>
            )}
          </Button>
        </div>
        {(analyzing || sending) && (
          <div className="loading-container">
            <p className="loading-text">
              {analyzing ? "Analyzing image for birds..." : "Sending bird to Ryan..."}
            </p>
          </div>
        )}
        {!analyzing && !sending && message && (
          <p className="text-center max-w-md">{message}</p>
        )}
        {birdImage && !sending && !analyzing && (
          <>
            <Button
              onClick={handleBirdSend}
              size="lg"
              className="w-full max-w-md mt-4"
            >
              <Send className="mr-2 h-5 w-5" />
              {showSendAnyway ? "Send Anyway" : "Send Bird to Ryan"}
            </Button>
            {showSendAnyway && (
              <p className="text-sm text-muted-foreground mt-2 max-w-md text-center">
                No bird was detected, but you can still send it if you're sure there's a bird!
              </p>
            )}
          </>
        )}
        {image && <img id="uploadedImage" src={image} alt="Uploaded" className="mt-4" />}
      </div>
      <div className="w-full max-w-7xl px-4">
        <h2 className="text-3xl md:text-4xl lg:text-5xl font-extrabold mb-8 text-center mt-12 text-white tracking-tight drop-shadow-lg">
          Latest Birds Sent to Ryan
        </h2>
        <div className="latest-birds">
          {Array.from({ length: 12 }).map((_, index) => {
            const imgUrl = lastImages[index];
            const isLoading = imgUrl && !imageLoadStates[imgUrl];
            
            return (
              <div key={index} className="relative w-full aspect-square rounded-lg overflow-hidden">
                {imgUrl ? (
                  <>
                    {isLoading && (
                      <div className="absolute inset-0 bg-gradient-to-br from-muted via-muted/50 to-muted animate-pulse" />
                    )}
                    <img
                      src={imgUrl}
                      alt={`Last uploaded ${index + 1}`}
                      loading="lazy"
                      onLoad={() => setImageLoadStates(prev => ({ ...prev, [imgUrl]: true }))}
                      onError={() => setImageLoadStates(prev => ({ ...prev, [imgUrl]: true }))}
                      className={`w-full h-full object-cover rounded-lg transition-opacity duration-500 ${
                        isLoading ? 'opacity-0' : 'opacity-100'
                      }`}
                    />
                  </>
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted via-muted/50 to-muted">
                    <div className="text-muted-foreground text-xs opacity-50">No image yet</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default App;
