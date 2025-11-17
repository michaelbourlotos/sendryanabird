import React, { useState, useEffect } from "react";
import * as mobilenet from "@tensorflow-models/mobilenet";
import * as tf from "@tensorflow/tfjs";
import "./App.css";

function App() {
  const [image, setImage] = useState(null);
  const [message, setMessage] = useState("");
  const [model, setModel] = useState(null);
  const [lastImages, setLastImages] = useState([]);
  const [birdImage, setBirdImage] = useState(null);
  const [extension, setExtension] = useState("");
  const [sending, setSending] = useState(false);

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

  const R2_PUBLIC_URL = process.env.REACT_APP_R2_PUBLIC_URL;

  useEffect(() => {
    const loadModel = async () => {
      const loadedModel = await mobilenet.load({ version: 2, alpha: 1.0 });
      setModel(loadedModel);
    };

    loadModel();
    fetchLastImages();
  }, []);

  const fetchLastImages = async () => {
    try {
      // Use Worker endpoint to list images (keeps R2 credentials secure)
      const workerUrl = process.env.REACT_APP_WORKER_URL || '';
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
        (item) => `${R2_PUBLIC_URL}/${item.Key}`
      );

      setLastImages(imageUrls);
    } catch (error) {
      console.error('Error fetching images:', error);
    }
  };

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
                setExtension('jpeg');
                classifyImage(imgElement);
            };
        };
        reader.readAsDataURL(file);
    }
}

  const classifyImage = async (imgElement) => {
    if (model) {
      const tensor = tf.browser
        .fromPixels(imgElement)
        .resizeNearestNeighbor([224, 224])
        .toFloat()
        .expandDims();
      const predictions = await model.classify(tensor);
      console.log(predictions);

      const birdDetected = predictions.some((prediction) =>
        birdClasses.includes(prediction.className.toLowerCase())
      );

      if (birdDetected) {
        setMessage(
          "Woah that bird is crazy, looks like a " +
            predictions[0].className +
            "! You should send it to Ryan!"
        );
        setBirdImage(imgElement);
      } else {
        setMessage(
          "This is not a bird! I think it is a " +
            predictions[0].className +
            ". Upload a bird image!"
        );
      }
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
          const workerUrl = process.env.REACT_APP_WORKER_URL || '';
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
          const imageUrl = `${R2_PUBLIC_URL}/${fileName}`;
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

  const sendSMS = async (imageUrl) => {
    try {
      const workerUrl = process.env.REACT_APP_WORKER_URL || '';
      const response = await fetch(
        `${workerUrl}/sms`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: "Check out this little beauty!",
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
      <h1>Send Ryan A Bird</h1>
      <div className="upload-area">
        <input
          type="file"
          accept="image/*"
          onInput={handleImageUpload}
        />
        <p>{message}</p>
        {birdImage && !sending && (
          <button onClick={handleBirdSend}>Send Bird to Ryan</button>
        )}
        {sending && <p>Sending bird to Ryan...</p>}
        {image && <img id="uploadedImage" src={image} alt="Uploaded" />}
      </div>
      <div>
        <h3>Lastest birds sent to Ryan</h3>
        <div className="latest-birds">
          {lastImages.map((imgUrl, index) => (
            <img key={index} src={imgUrl} alt={`Last uploaded ${index + 1}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
